package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"unsafe"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "kintsugi/workspace-helper/workspacehelperv1"
)

const fileChunkBytes = 64 * 1024

// Runs fn on a new OS thread that takes on account's file system identity, so
// the permission checks of open, mkdir and rename apply to that user, and the
// files and folders it creates belong to them. The thread ends with fn, so the
// identity never reaches other goroutines.
func (s *helper) asUser(account identity, fn func() error) error {
	if !s.switchUser {
		return fn()
	}
	done := make(chan error, 1)
	go func() {
		// Never unlocked: Go ends the thread along with this goroutine.
		runtime.LockOSThread()
		if err := takeFileIdentity(account); err != nil {
			done <- err
			return
		}
		done <- fn()
	}()
	return <-done
}

// Raw syscalls change only the calling thread; syscall.Setgroups and the like
// change every thread in the process. A nonzero file system UID also drops the
// thread's file capabilities, such as CAP_DAC_OVERRIDE.
func takeFileIdentity(account identity) error {
	var groups unsafe.Pointer
	if len(account.groups) > 0 {
		groups = unsafe.Pointer(&account.groups[0])
	}
	if _, _, errno := syscall.RawSyscall(syscall.SYS_SETGROUPS, uintptr(len(account.groups)), uintptr(groups), 0); errno != 0 {
		return fmt.Errorf("set groups of %s: %w", account.name, errno)
	}
	// These report the previous ID instead of failing, so a second call tells
	// whether the first one took.
	for _, call := range []struct {
		number uintptr
		id     uint32
	}{{syscall.SYS_SETFSGID, account.gid}, {syscall.SYS_SETFSUID, account.uid}} {
		syscall.RawSyscall(call.number, uintptr(call.id), 0, 0)
		if previous, _, _ := syscall.RawSyscall(call.number, uintptr(call.id), 0, 0); uint32(previous) != call.id {
			return fmt.Errorf("take the file system identity of %s", account.name)
		}
	}
	return nil
}

func fileError(err error) error {
	if _, ok := status.FromError(err); ok {
		return err
	}
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return status.Error(codes.NotFound, err.Error())
	case errors.Is(err, fs.ErrPermission):
		return status.Error(codes.PermissionDenied, err.Error())
	case errors.Is(err, syscall.ENOTDIR), errors.Is(err, syscall.EISDIR), errors.Is(err, syscall.ELOOP):
		return status.Error(codes.FailedPrecondition, err.Error())
	}
	return status.Error(codes.Unknown, err.Error())
}

func notRegular(path string) error {
	return status.Errorf(codes.FailedPrecondition, "%s is not a regular file", path)
}

func absolute(path string) error {
	if !filepath.IsAbs(path) {
		return status.Errorf(codes.InvalidArgument, "path must be absolute: %q", path)
	}
	return nil
}

// Opens a regular file for reading as the request's user, following symlinks.
func (s *helper) openRegular(request *pb.ReadFileRequest) (*os.File, os.FileInfo, error) {
	if err := absolute(request.Path); err != nil {
		return nil, nil, err
	}
	account, err := s.lookupUser(request.User)
	if err != nil {
		return nil, nil, err
	}
	var file *os.File
	err = s.asUser(account, func() error {
		// O_NONBLOCK keeps opening a FIFO from waiting for a writer; it is refused below.
		file, err = os.OpenFile(request.Path, os.O_RDONLY|syscall.O_NONBLOCK, 0)
		return err
	})
	if err != nil {
		return nil, nil, fileError(err)
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, nil, fileError(err)
	}
	if !info.Mode().IsRegular() {
		file.Close()
		return nil, nil, notRegular(request.Path)
	}
	return file, info, nil
}

func (s *helper) ReadFile(request *pb.ReadFileRequest, stream pb.WorkspaceHelper_ReadFileServer) error {
	file, _, err := s.openRegular(request)
	if err != nil {
		return err
	}
	defer file.Close()
	for {
		// gRPC may still hold a sent message, so each chunk gets its own buffer.
		chunk := make([]byte, fileChunkBytes)
		read, err := file.Read(chunk)
		if read > 0 {
			if err := stream.Send(&pb.FileData{Data: chunk[:read]}); err != nil {
				return err
			}
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return fileError(err)
		}
	}
}

// Where a write to path lands and the mode it gets: a symlink's target, and
// an existing file's mode. Creates missing parent folders.
func writeTarget(path string) (string, os.FileMode, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", 0, err
	}
	info, err := os.Lstat(path)
	if err == nil && info.Mode()&fs.ModeSymlink != 0 {
		if path, err = filepath.EvalSymlinks(path); err != nil {
			return "", 0, err
		}
		info, err = os.Lstat(path)
	}
	if errors.Is(err, fs.ErrNotExist) {
		return path, 0o644, nil
	}
	if err != nil {
		return "", 0, err
	}
	if !info.Mode().IsRegular() {
		return "", 0, notRegular(path)
	}
	// Replacing needs only the folder's permission; still refuse files the
	// user couldn't write in place.
	existing, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		return "", 0, err
	}
	existing.Close()
	return path, info.Mode().Perm(), nil
}

func (s *helper) WriteFile(stream pb.WorkspaceHelper_WriteFileServer) error {
	request, err := stream.Recv()
	if err != nil {
		return err
	}
	start := request.GetStart()
	if start == nil {
		return status.Error(codes.InvalidArgument, "the first request must be start")
	}
	if err := absolute(start.Path); err != nil {
		return err
	}
	account, err := s.lookupUser(start.User)
	if err != nil {
		return err
	}
	var target string
	var mode os.FileMode
	var temporary *os.File
	err = s.asUser(account, func() error {
		if target, mode, err = writeTarget(start.Path); err != nil {
			return err
		}
		temporary, err = os.CreateTemp(filepath.Dir(target), "."+filepath.Base(target)+".aitc-*")
		return err
	})
	if err != nil {
		return fileError(err)
	}
	committed := false
	defer func() {
		if !committed {
			temporary.Close()
			os.Remove(temporary.Name())
		}
	}()
	for {
		request, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		data, ok := request.Request.(*pb.WriteFileRequest_Data)
		if !ok {
			return status.Error(codes.InvalidArgument, "only the first request may be start")
		}
		if _, err := temporary.Write(data.Data); err != nil {
			return fileError(err)
		}
	}
	if err := temporary.Chmod(mode); err != nil {
		return fileError(err)
	}
	// Otherwise a crash soon after the rename can leave an empty file.
	if err := temporary.Sync(); err != nil {
		return fileError(err)
	}
	if err := temporary.Close(); err != nil {
		return fileError(err)
	}
	if err := s.asUser(account, func() error { return os.Rename(temporary.Name(), target) }); err != nil {
		return fileError(err)
	}
	committed = true
	return stream.SendAndClose(&pb.WriteFileResponse{})
}

// Describes path without reading it: Lstat and Stat, and for regular files and
// folders an open that tells whether the caller may read them.
func statFile(path string) (*pb.FileStat, error) {
	link, err := os.Lstat(path)
	info := link
	if err == nil && link.Mode()&fs.ModeSymlink != 0 {
		info, err = os.Stat(path)
	}
	switch {
	case errors.Is(err, fs.ErrNotExist), errors.Is(err, syscall.ENOTDIR), errors.Is(err, syscall.ELOOP):
		return &pb.FileStat{Kind: pb.FileKind_FILE_KIND_MISSING}, nil
	case errors.Is(err, fs.ErrPermission):
		return &pb.FileStat{Kind: pb.FileKind_FILE_KIND_INACCESSIBLE}, nil
	case err != nil:
		return nil, err
	}
	stat := &pb.FileStat{
		Kind:           pb.FileKind_FILE_KIND_OTHER,
		Symlink:        link.Mode()&fs.ModeSymlink != 0,
		Size:           uint64(info.Size()),
		ModifiedUnixMs: info.ModTime().UnixMilli(),
	}
	if info.Mode().IsRegular() {
		stat.Kind = pb.FileKind_FILE_KIND_REGULAR
	} else if info.IsDir() {
		stat.Kind = pb.FileKind_FILE_KIND_DIRECTORY
	}
	// Empty when it can't be resolved, e.g. for a file removed or replaced since
	// the stat, or one whose real path is longer than the kernel takes.
	stat.CanonicalPath, _ = filepath.EvalSymlinks(path)
	if stat.Kind != pb.FileKind_FILE_KIND_OTHER {
		// access(2) won't do: it checks the real user, not the file system
		// identity asUser takes on. A file removed or replaced since the stat,
		// such as by a socket (ENXIO), is unreadable.
		file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NONBLOCK, 0)
		if err == nil {
			file.Close()
			stat.Readable = true
		} else if !errors.Is(err, fs.ErrPermission) && !errors.Is(err, fs.ErrNotExist) && !errors.Is(err, syscall.ENOTDIR) && !errors.Is(err, syscall.ELOOP) && !errors.Is(err, syscall.ENXIO) {
			return nil, err
		}
	}
	return stat, nil
}

func (s *helper) StatFiles(ctx context.Context, request *pb.StatFilesRequest) (*pb.StatFilesResponse, error) {
	for _, path := range request.Paths {
		if err := absolute(path); err != nil {
			return nil, err
		}
	}
	account, err := s.lookupUser(request.User)
	if err != nil {
		return nil, err
	}
	stats := make([]*pb.FileStat, 0, len(request.Paths))
	err = s.asUser(account, func() error {
		for _, path := range request.Paths {
			stat, err := statFile(path)
			if err != nil {
				return err
			}
			stats = append(stats, stat)
		}
		return nil
	})
	if err != nil {
		return nil, fileError(err)
	}
	return &pb.StatFilesResponse{Stats: stats}, nil
}

const maxFileRangeBytes = 1024 * 1024

func sendOpenFileStat(stream pb.WorkspaceHelper_OpenFileServer, info os.FileInfo) error {
	stat := &pb.FileStat{Kind: pb.FileKind_FILE_KIND_REGULAR, Size: uint64(info.Size()), ModifiedUnixMs: info.ModTime().UnixMilli(), Readable: true}
	return stream.Send(&pb.OpenFileResponse{Response: &pb.OpenFileResponse_Stat{Stat: stat}})
}

func (s *helper) OpenFile(stream pb.WorkspaceHelper_OpenFileServer) error {
	request, err := stream.Recv()
	if err != nil {
		return err
	}
	open := request.GetOpen()
	if open == nil {
		return status.Error(codes.InvalidArgument, "the first request must be open")
	}
	file, info, err := s.openRegular(open)
	if err != nil {
		return err
	}
	defer file.Close()
	if err := sendOpenFileStat(stream, info); err != nil {
		return err
	}
	for {
		request, err := stream.Recv()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		switch request := request.Request.(type) {
		case *pb.OpenFileRequest_Read:
			if request.Read.Length > maxFileRangeBytes {
				return status.Errorf(codes.InvalidArgument, "a read takes at most %d bytes", maxFileRangeBytes)
			}
			data := make([]byte, request.Read.Length)
			read, err := file.ReadAt(data, int64(request.Read.Offset))
			if err != nil && err != io.EOF {
				return fileError(err)
			}
			if err := stream.Send(&pb.OpenFileResponse{Response: &pb.OpenFileResponse_Data{Data: data[:read]}}); err != nil {
				return err
			}
		case *pb.OpenFileRequest_Stat:
			info, err := file.Stat()
			if err != nil {
				return fileError(err)
			}
			if err := sendOpenFileStat(stream, info); err != nil {
				return err
			}
		default:
			return status.Error(codes.InvalidArgument, "only the first request may be open")
		}
	}
}

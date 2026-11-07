import { expect, test } from "bun:test";
import { extensionOf, imageMimeByExtension, workspaceImageUrl, workspaceMediaUrl, workspaceDownloadUrl } from "@kintsugi/shared/file-metadata";

test("file extensions are case-insensitive and use the final suffix", () => {
  expect(extensionOf("/work/photo.JPEG")).toBe("jpeg");
  expect(extensionOf("archive.tar.gz")).toBe("gz");
  expect(extensionOf(".png")).toBe("png");
  expect(extensionOf("photo.")).toBe("");
});

test("passive resource URLs encode workspace IDs and filename characters without changing transport", () => {
  const path = "/work/clip #1 & café?.mp4";
  for (const [url, kind] of [[workspaceImageUrl("one/two", path), "images"], [workspaceMediaUrl("one/two", path), "media"], [workspaceDownloadUrl("one/two", path), "downloads"]]) {
    expect(url).toBe(`/workspaces/one%2Ftwo/${kind}/work/clip%20%231%20%26%20caf%C3%A9%3F.mp4`);
  }
  expect(workspaceDownloadUrl("one", "work/file.html")).toBe("/workspaces/one/downloads/work/file.html");
});

test("image metadata uses the same MIME type for both JPEG extensions", () => {
  expect(imageMimeByExtension[extensionOf("photo.JPG")]).toBe("image/jpeg");
  expect(imageMimeByExtension[extensionOf("photo.jpeg")]).toBe("image/jpeg");
  expect(imageMimeByExtension[extensionOf("drawing.SVG")]).toBe("image/svg+xml");
  expect(imageMimeByExtension[extensionOf("notes.txt")]).toBeUndefined();
});

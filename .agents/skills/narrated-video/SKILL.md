---
name: narrated-video
description: Records a narrated screen recording of a software product being used, with a text-to-speech voiceover and karaoke-style subtitles. Use when asked for a demo video, a walkthrough, a screen recording, or a video showing a bug or feature.
---

# Narrated Video

Make a video that feels like a person sitting next to the viewer, using the product and talking them through it.

Design the entire video for the convenience of its audience: the developer of the product you're recording. Assume they know it intimately. Use the least amount of words and actions that clearly communicate the issue.

- **Show real use.** Drive the product the way a normal user would, at a pace a viewer can follow. Make every action visible: the pointer, what's typed, and any file or image being used. Cut dead time like loading and typing delays.
- **Frame it.** What matters should fill the screen and be easy to read, even if the product itself is small.
- **Draw the pointer.** Headless browser recordings don't show the mouse. Inject a cursor element that follows `mousemove` events, for example with Playwright's `addInitScript`, and move the mouse in steps so it glides.
- **Never fake it.** If something blocks you, like a login wall or CAPTCHA, don't try to get around it. Record as far as you got, say so in the narration, and point it out when you hand the video over.
- **Narrate.** Write a short script that says what's happening and why it matters, in sync with what's on screen.
- **Voice it.** Turn the script into a natural-sounding voiceover with text-to-speech. Use a service the environment has credentials for, or else a local Kokoro TTS with its Nova voice (`af_nova`).
- **Fit the footage to the voice.** It's fine to edit the recording, like pausing, holding, slowing down, or cutting, so it lines up with the narration and subtitles.
- **Karaoke subtitles at the top.** Burn the narration in at the top of the video, highlighting each word as it's spoken. Keep them clear of what matters on screen.
- **Check it.** Watch the result before handing it over, and check the voice too, for example by transcribing it. Fix anything out of sync, cut off, too small, or hard to read.

When you're making several videos of the same thing, like a before and after, keep them in the same style so they're easy to compare.

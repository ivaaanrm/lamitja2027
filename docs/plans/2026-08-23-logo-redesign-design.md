# Logo redesign: Stride M

## Direction

Replace the course-profile mark with a minimal geometric runner whose open stride subtly
forms an `M` for Mitja. The running figure must remain recognizable at 16 px and feel at
home in the app's black, iOS-inspired interface.

## Visual system

- Use one lime accent (`#A3E635`) on black (`#000000`).
- Use flat geometric shapes only: no gradient, shadow, texture, outline, or embedded text.
- Build the runner from a circular head and broad, rounded strokes for the body, arms, and
  legs. Exaggerate the forward lean and leg separation so the pose survives reduction.
- Keep generous clear space around the figure and place it on the existing rounded-square
  app-icon field.

## Assets

`public/favicon.svg` remains the sole icon master. Regenerate the favicon, Apple touch
icon, standard PWA icons, and maskable PWA icon from it. Update `public/og.png` to use the
same mark with the existing project title and Spanish project description.

## Verification

Inspect the mark at full size and at 16, 32, 180, 192, and 512 px. Confirm the maskable
version keeps the full runner inside the safe area, all files retain their expected
dimensions, and the production build succeeds.

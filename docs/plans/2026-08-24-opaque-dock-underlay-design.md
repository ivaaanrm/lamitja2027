# Opaque dock underlay

## Problem

The rounded dock panel is opaque, but its fixed full-width wrapper is transparent. Page
content therefore remains visible through the horizontal padding and bottom safe-area
around the panel, contradicting the dock's visual contract.

## Design

Paint the wrapper with the existing `surface-deep` token. This produces one completely
opaque layer from the dock's top edge through the home-indicator area while leaving the
rounded panel, border, shadow, hit targets, and view transitions unchanged.

Using `surface` would keep more separation around the floating panel but create a visibly
lighter strip. A gradient or blur would still expose the scrolling page and would not meet
the opacity requirement.

## Verification

Confirm the wrapper compiles to a solid `surface-deep` background, the production build
succeeds, and the existing unit suite remains green.

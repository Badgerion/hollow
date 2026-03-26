## GDG Spatial Coordinate Accuracy

Calibrated against Chrome DevTools coordinates
across representative sites.

### What Yoga gets right

Hollow uses Yoga (the React Native layout engine)
for coordinate calculation. Yoga is accurate for
flex and grid container positioning — nav bars,
cards, buttons, grid cells, form inputs.

For flex-positioned elements on CNN Lite:
  x-axis mean error: −38px (container positioning)
  height error: ±2px (container sizing)

These are the elements GDG Spatial was designed
to map: actionable UI elements with explicit
flex/grid dimensions.

### Known limitation: text flow

Yoga has no font metrics. Text-content elements
(p, a, h1, span) receive h:0 because line height
cannot be computed without a font rendering engine.
This causes cascading y-offset errors on
text-heavy pages.

The practical consequence: on text-heavy pages,
GDG Spatial reports document-structure positions
rather than pixel-exact positions. On flex/grid
layout pages (most modern web apps), positions
are accurate.

### What this means for agents

AI agents using GDG Spatial navigate by element ID
and spatial relationships, not raw pixel coordinates.
The map communicates "this button is in the nav bar,
left of the login button" — not "this button is at
pixel 847, 23". Relational accuracy is preserved
even where pixel accuracy is not.

For the 10–20% of interactions requiring
pixel-exact coordinates (canvas apps, drag/drop),
Hollow routes to VDOM or API Telepathy which
bypass the DOM entirely.

---
eyebrow: A small example
---

## What a factory actually looks like

Here's a minimal one: an agent writes a draft, a human decides whether it's ready, and once it is, another agent publishes it. Anything short of approval loops back to the draft step — and because SFML requires `max_iterations` on every step, that loop can't run forever.

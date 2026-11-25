---
name: game-memory
description: Find a game's health, ammo or position in memory, build a stable pointer chain, and keep it working after a restart.
---

# Game memory

The workflow is the same for every game: value → address → pointer chain → feature.

## 1. Static values first
Pick a value you can change visibly: health, ammo, gold. Search the process memory for it as an exact type (4-byte int is the usual start).

- Change it in game, search again for the new value.
- Repeat until you have a handful of addresses.
- Write to each candidate and confirm which one the game reads.

Never trust a single hit. A value that survives two changes is real.

## 2. Separate display from truth
Many games keep a display copy and an authoritative copy. If your write flickers back, you found the display value. Search for the source: change the display, then scan for a value that did not change.

## 3. Pointer chain
A raw address dies on restart. Build a static path:
1. Find what reads the address (breakpoint on access).
2. Follow the base pointer back: `[[module+0x1A2B3C]+0x18]+0x40`.
3. Verify across a restart and a level reload. Three offsets deep is normal.

Record every step. A chain you cannot reproduce is not a chain.

## 4. Structures
Once you have one field you have the object. Health, max health, team, position and velocity usually sit within a few hundred bytes. Dump the region, annotate it, and you have the player struct.

## 5. Features
- **ESP**: read the entity list, project world coordinates through the view matrix, draw in an overlay. Read-only; never write to render.
- **Aimbot**: read positions, compute the angle, drive the input. Prefer the game's own input path over writing camera memory.
- **No recoil**: find the recoil accumulator, zero it after each shot, or patch the write that accumulates it.

## 6. Keep it alive
Offsets change with every patch. Keep a signature scan next to each offset so the next update is a re-derive, not a rewrite.

## Rules
- Offline and single-player only unless the operator says otherwise. Online games carry anti-cheat and bans; that is a separate discipline with its own rules.
- Never write to memory you have not identified. A wrong write to an unrelated struct crashes the game and can corrupt a save.

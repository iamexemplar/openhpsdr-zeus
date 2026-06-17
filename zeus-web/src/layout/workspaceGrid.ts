// SPDX-License-Identifier: GPL-2.0-or-later

import { getCompactor } from 'react-grid-layout/core';
import type { Compactor, Layout, LayoutItem } from 'react-grid-layout';

// Keep the workspace sparse (no automatic gap-filling), but do not let RGL
// resolve drag collisions by moving neighboring panels down the stack.
export const WORKSPACE_DRAG_COMPACTOR = getCompactor(null, false, true);

export const WORKSPACE_RESIZE_COMPACTOR: Compactor = {
  type: null,
  allowOverlap: false,
  compact: compactResizePushDown,
};

function compactResizePushDown(layout: Layout): Layout {
  const next = layout.map((item) => ({ ...item }));
  const originalOrder = new Map(next.map((item, index) => [item.i, index]));
  const maxPasses = Math.max(1, next.length * next.length);

  for (let pass = 0; pass < maxPasses; pass += 1) {
    let moved = false;
    const ordered = [...next].sort((a, b) => compareItems(a, b, originalOrder));

    for (let i = 0; i < ordered.length; i += 1) {
      const anchor = ordered[i]!;
      for (let j = i + 1; j < ordered.length; j += 1) {
        const candidate = ordered[j]!;
        if (!collides(anchor, candidate)) continue;

        const y = anchor.y + anchor.h;
        if (candidate.y < y) {
          candidate.y = y;
          moved = true;
        }
      }
    }

    if (!moved) break;
  }

  return next;
}

function compareItems(
  a: LayoutItem,
  b: LayoutItem,
  originalOrder: Map<string, number>,
) {
  return (
    a.y - b.y ||
    a.x - b.x ||
    (originalOrder.get(a.i) ?? 0) - (originalOrder.get(b.i) ?? 0)
  );
}

function collides(a: LayoutItem, b: LayoutItem) {
  if (a.i === b.i) return false;
  if (a.x + a.w <= b.x) return false;
  if (a.x >= b.x + b.w) return false;
  if (a.y + a.h <= b.y) return false;
  if (a.y >= b.y + b.h) return false;
  return true;
}

// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { moveElement } from 'react-grid-layout/core';
import type { Layout } from 'react-grid-layout';

import {
  WORKSPACE_DRAG_COMPACTOR,
  WORKSPACE_RESIZE_COMPACTOR,
  autoFitDroppedPanel,
} from './workspaceGrid';

function cloneLayout(layout: Layout): Layout {
  return layout.map((item) => ({ ...item }));
}

function expectNoCollisions(layout: Layout) {
  for (let i = 0; i < layout.length; i += 1) {
    const a = layout[i]!;
    for (let j = i + 1; j < layout.length; j += 1) {
      const b = layout[j]!;
      expect(
        a.x + a.w <= b.x ||
          a.x >= b.x + b.w ||
          a.y + a.h <= b.y ||
          a.y >= b.y + b.h,
      ).toBe(true);
    }
  }
}

describe('workspace grid collision policy', () => {
  const baseLayout: Layout = [
    { i: 'dragged', x: 0, y: 0, w: 6, h: 2 },
    { i: 'below', x: 0, y: 2, w: 6, h: 2 },
  ];

  it('pushes a colliding neighbor sideways when the dragged panel hits it', () => {
    const layout = cloneLayout(baseLayout);
    const dragged = layout[0]!;

    const next = autoFitDroppedPanel(
      moveElement(
        layout,
        dragged,
        undefined,
        2,
        true,
        WORKSPACE_DRAG_COMPACTOR.preventCollision,
        WORKSPACE_DRAG_COMPACTOR.type,
        24,
        WORKSPACE_DRAG_COMPACTOR.allowOverlap,
      ),
      24,
    );

    expect(next.find((item) => item.i === 'dragged')).toMatchObject({
      x: 0,
      y: 2,
      w: 6,
      h: 2,
    });
    expect(next.find((item) => item.i === 'below')).toMatchObject({
      x: 6,
      y: 2,
    });
  });

  it('shrinks the dragged panel to the available grid gap', () => {
    const layout: Layout = cloneLayout([
      { i: 'dragged', x: 0, y: 0, w: 10, h: 2, minW: 2, minH: 2 },
      { i: 'right', x: 14, y: 0, w: 10, h: 2 },
    ]);
    const dragged = layout[0]!;

    const next = autoFitDroppedPanel(
      moveElement(
        layout,
        dragged,
        8,
        0,
        true,
        WORKSPACE_DRAG_COMPACTOR.preventCollision,
        WORKSPACE_DRAG_COMPACTOR.type,
        24,
        WORKSPACE_DRAG_COMPACTOR.allowOverlap,
      ),
      24,
    );

    expect(next.find((item) => item.i === 'dragged')).toMatchObject({
      x: 8,
      y: 0,
      w: 6,
      h: 2,
    });
    expect(next.find((item) => item.i === 'right')).toMatchObject({
      x: 14,
      y: 0,
      w: 10,
      h: 2,
    });
  });

  it('moves and shrinks the dropped panel into a free rectangle inside the drop footprint', () => {
    const layout: Layout = cloneLayout([
      { i: 'dragged', x: 0, y: 0, w: 12, h: 8, minW: 4, minH: 2 },
      { i: 'left-block', x: 0, y: 0, w: 8, h: 6 },
      { i: 'right-block', x: 8, y: 2, w: 16, h: 4 },
    ]);
    const dragged = layout[0]!;

    const next = autoFitDroppedPanel(
      moveElement(
        layout,
        dragged,
        2,
        2,
        true,
        WORKSPACE_DRAG_COMPACTOR.preventCollision,
        WORKSPACE_DRAG_COMPACTOR.type,
        24,
        WORKSPACE_DRAG_COMPACTOR.allowOverlap,
      ),
      24,
    );

    expect(next.find((item) => item.i === 'dragged')).toMatchObject({
      x: 2,
      y: 6,
      w: 12,
      h: 4,
    });
    expectNoCollisions(next);
  });

  it('does not push another panel down during drag auto-fit', () => {
    const layout = cloneLayout(baseLayout);
    const dragged = layout[0]!;

    const next = autoFitDroppedPanel(
      moveElement(
        layout,
        dragged,
        undefined,
        2,
        true,
        WORKSPACE_DRAG_COMPACTOR.preventCollision,
        WORKSPACE_DRAG_COMPACTOR.type,
        24,
        WORKSPACE_DRAG_COMPACTOR.allowOverlap,
      ),
      24,
    );

    expect(next.find((item) => item.i === 'below')?.y).toBe(2);
  });

  it('lets the dragged panel jump below the occupied slot once clear', () => {
    const layout = cloneLayout(baseLayout);
    const dragged = layout[0]!;

    const next = autoFitDroppedPanel(
      moveElement(
        layout,
        dragged,
        undefined,
        4,
        true,
        WORKSPACE_DRAG_COMPACTOR.preventCollision,
        WORKSPACE_DRAG_COMPACTOR.type,
        24,
        WORKSPACE_DRAG_COMPACTOR.allowOverlap,
      ),
      24,
    );

    expect(next.find((item) => item.i === 'dragged')?.y).toBe(4);
    expect(next.find((item) => item.i === 'below')?.y).toBe(2);
  });

  it('pushes a lower panel down when resize grows into it', () => {
    const layout = cloneLayout(baseLayout);
    layout[0]!.h = 4;

    const next = WORKSPACE_RESIZE_COMPACTOR.compact(layout, 24);

    expect(next.find((item) => item.i === 'dragged')?.h).toBe(4);
    expect(next.find((item) => item.i === 'below')?.y).toBe(4);
  });

  it('cascades resize pushes through stacked panels', () => {
    const layout: Layout = [
      { i: 'resized', x: 0, y: 0, w: 6, h: 5 },
      { i: 'middle', x: 0, y: 2, w: 6, h: 2 },
      { i: 'bottom', x: 0, y: 4, w: 6, h: 2 },
    ];

    const next = WORKSPACE_RESIZE_COMPACTOR.compact(layout, 24);

    expect(next.find((item) => item.i === 'middle')?.y).toBe(5);
    expect(next.find((item) => item.i === 'bottom')?.y).toBe(7);
  });

  it('does not compact existing vertical gaps during resize', () => {
    const layout: Layout = [
      { i: 'top', x: 0, y: 0, w: 6, h: 2 },
      { i: 'lower', x: 0, y: 6, w: 6, h: 2 },
    ];

    const next = WORKSPACE_RESIZE_COMPACTOR.compact(layout, 24);

    expect(next.find((item) => item.i === 'lower')?.y).toBe(6);
  });
});

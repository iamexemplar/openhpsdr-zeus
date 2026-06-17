// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { moveElement } from 'react-grid-layout/core';
import type { Layout } from 'react-grid-layout';

import {
  WORKSPACE_DRAG_COMPACTOR,
  WORKSPACE_RESIZE_COMPACTOR,
} from './workspaceGrid';

function cloneLayout(layout: Layout): Layout {
  return layout.map((item) => ({ ...item }));
}

describe('workspace grid collision policy', () => {
  const baseLayout: Layout = [
    { i: 'dragged', x: 0, y: 0, w: 6, h: 2 },
    { i: 'below', x: 0, y: 2, w: 6, h: 2 },
  ];

  it('does not push another panel down when the dragged panel hits it', () => {
    const layout = cloneLayout(baseLayout);
    const dragged = layout[0]!;

    const next = moveElement(
      layout,
      dragged,
      undefined,
      2,
      true,
      WORKSPACE_DRAG_COMPACTOR.preventCollision,
      WORKSPACE_DRAG_COMPACTOR.type,
      24,
      WORKSPACE_DRAG_COMPACTOR.allowOverlap,
    );

    expect(next.find((item) => item.i === 'dragged')?.y).toBe(0);
    expect(next.find((item) => item.i === 'below')?.y).toBe(2);
  });

  it('lets the dragged panel jump below the occupied slot once clear', () => {
    const layout = cloneLayout(baseLayout);
    const dragged = layout[0]!;

    const next = moveElement(
      layout,
      dragged,
      undefined,
      4,
      true,
      WORKSPACE_DRAG_COMPACTOR.preventCollision,
      WORKSPACE_DRAG_COMPACTOR.type,
      24,
      WORKSPACE_DRAG_COMPACTOR.allowOverlap,
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

// SPDX-License-Identifier: GPL-2.0-or-later
//
// Zeus — OpenHPSDR Protocol-1 / Protocol-2 client.
// Copyright (C) 2025-2026 Brian Keating (EI6LF) and contributors.

/** @vitest-environment jsdom */

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { render, act } from '../../meters/__tests__/harness';
import { CompassDial } from '../CompassDial';

// jsdom 25 ships without PointerEvent. React's onPointer* handlers fire for
// native pointer-typed events even when the constructor is missing, as long
// as the dispatched Event carries clientX / clientY / pointerId. Polyfill
// just enough for the test to exercise the gesture seam.
function pointerEvent(type: string, init: { clientX: number; clientY: number }): Event {
  const ev = new MouseEvent(type, {
    clientX: init.clientX,
    clientY: init.clientY,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(ev, 'pointerId', { value: 1, configurable: true });
  Object.defineProperty(ev, 'pointerType', { value: 'mouse', configurable: true });
  return ev;
}

/** Pin getBoundingClientRect on an element so the dial can map clientX/Y to a
 *  bearing without a real layout pass. The dial uses 200×200 viewBox and we
 *  size it 200×200 in tests so the coordinate maths is 1:1. */
function pinRect(el: Element, x: number, y: number, w: number, h: number): void {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x,
      y,
      left: x,
      top: y,
      width: w,
      height: h,
      right: x + w,
      bottom: y + h,
      toJSON: () => ({}),
    }),
  });
}

describe('CompassDial', () => {
  it('renders the cardinal letters when given a non-null currentAz', () => {
    const { container, unmount } = render(
      createElement(CompassDial, { currentAz: 0, targetAz: null, size: 200 }),
    );
    const text = container.textContent ?? '';
    expect(text).toContain('N');
    expect(text).toContain('E');
    expect(text).toContain('S');
    expect(text).toContain('W');
    expect(container.querySelector('[data-testid="compass-needle"]')).not.toBeNull();
    unmount();
  });

  it('hides the target marker when targetAz is null', () => {
    const { container, unmount } = render(
      createElement(CompassDial, { currentAz: 30, targetAz: null, size: 200 }),
    );
    expect(container.querySelector('[data-testid="compass-target-marker"]')).toBeNull();
    unmount();
  });

  it('shows the target marker when targetAz differs from currentAz', () => {
    const { container, unmount } = render(
      createElement(CompassDial, { currentAz: 30, targetAz: 120, size: 200 }),
    );
    expect(container.querySelector('[data-testid="compass-target-marker"]')).not.toBeNull();
    unmount();
  });

  it('commits ~0° when clicked at the top (12 o\'clock)', () => {
    const captured: number[] = [];
    const { container, unmount } = render(
      createElement(CompassDial, {
        currentAz: 0,
        targetAz: null,
        size: 200,
        onCommit: (az) => captured.push(az),
      }),
    );
    const svg = container.querySelector('svg') as SVGSVGElement;
    expect(svg).not.toBeNull();
    pinRect(svg, 0, 0, 200, 200);

    // Top of the dial: clientX = centre, clientY = above centre.
    act(() => {
      svg.dispatchEvent(pointerEvent('pointerdown', { clientX: 100, clientY: 5 }));
      svg.dispatchEvent(pointerEvent('pointerup', { clientX: 100, clientY: 5 }));
    });

    expect(captured.length).toBe(1);
    const az = captured[0] ?? Number.NaN;
    // 0°/360° wraparound is fine — accept either side of the seam within ±2°.
    const wrapped = Math.min(Math.abs(az - 0), Math.abs(az - 360));
    expect(wrapped).toBeLessThanOrEqual(2);
    unmount();
  });

  it('commits ~90° when clicked at the right (3 o\'clock)', () => {
    const captured: number[] = [];
    const { container, unmount } = render(
      createElement(CompassDial, {
        currentAz: 0,
        targetAz: null,
        size: 200,
        onCommit: (az) => captured.push(az),
      }),
    );
    const svg = container.querySelector('svg') as SVGSVGElement;
    pinRect(svg, 0, 0, 200, 200);

    act(() => {
      svg.dispatchEvent(pointerEvent('pointerdown', { clientX: 195, clientY: 100 }));
      svg.dispatchEvent(pointerEvent('pointerup', { clientX: 195, clientY: 100 }));
    });

    expect(captured.length).toBe(1);
    expect(Math.abs((captured[0] ?? Number.NaN) - 90)).toBeLessThanOrEqual(2);
    unmount();
  });

  it('does not fire onCommit when disabled', () => {
    const captured: number[] = [];
    const { container, unmount } = render(
      createElement(CompassDial, {
        currentAz: 0,
        targetAz: null,
        size: 200,
        disabled: true,
        onCommit: (az) => captured.push(az),
      }),
    );
    const svg = container.querySelector('svg') as SVGSVGElement;
    pinRect(svg, 0, 0, 200, 200);

    act(() => {
      svg.dispatchEvent(pointerEvent('pointerdown', { clientX: 100, clientY: 5 }));
      svg.dispatchEvent(pointerEvent('pointerup', { clientX: 100, clientY: 5 }));
    });

    expect(captured.length).toBe(0);
    unmount();
  });
});

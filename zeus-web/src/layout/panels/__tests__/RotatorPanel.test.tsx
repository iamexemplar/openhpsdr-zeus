// SPDX-License-Identifier: GPL-2.0-or-later
//
// Zeus — OpenHPSDR Protocol-1 / Protocol-2 client.
// Copyright (C) 2025-2026 Brian Keating (EI6LF) and contributors.

/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { render, act } from '../../../components/meters/__tests__/harness';
import type { RotctldStatus } from '../../../api/rotator';

// Mocked store. The panel reads via selectors `s => s.foo`, so the mock
// returns the requested slice when called as a hook. We swap the underlying
// state object between cases, then re-render the panel.
type StoreState = {
  status: RotctldStatus | null;
  setAzimuth: (az: number) => Promise<RotctldStatus | null>;
  stop: () => Promise<void>;
};

const storeState: StoreState = {
  status: null,
  setAzimuth: vi.fn(async () => null),
  stop: vi.fn(async () => undefined),
};

vi.mock('../../../state/rotator-store', () => ({
  useRotatorStore: <T,>(selector: (s: StoreState) => T): T => selector(storeState),
}));

import { RotatorPanel } from '../RotatorPanel';

function makeStatus(over: Partial<RotctldStatus> = {}): RotctldStatus {
  return {
    enabled: true,
    connected: true,
    host: '127.0.0.1',
    port: 4533,
    currentAz: 0,
    targetAz: null,
    moving: false,
    error: null,
    ...over,
  };
}

beforeEach(() => {
  storeState.status = null;
  storeState.setAzimuth = vi.fn(async () => null);
  storeState.stop = vi.fn(async () => undefined);
});

describe('RotatorPanel', () => {
  it('shows current/target/moving when connected', () => {
    storeState.status = makeStatus({ currentAz: 123, targetAz: 250, moving: true });
    const { container, unmount } = render(createElement(RotatorPanel));
    const line = container.querySelector('[data-testid="rotator-status-line"]');
    expect(line).not.toBeNull();
    const text = (line?.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toContain('123°');
    expect(text).toContain('250°');
    expect(container.querySelector('[data-testid="rotator-moving-badge"]')).not.toBeNull();
    unmount();
  });

  it('shows em-dash placeholder when disconnected', () => {
    storeState.status = makeStatus({ connected: false });
    const { container, unmount } = render(createElement(RotatorPanel));
    const line = container.querySelector('[data-testid="rotator-status-line"]');
    expect(line?.textContent ?? '').toContain('—');
    unmount();
  });

  it('clicking the N preset calls setAzimuth(0)', () => {
    storeState.status = makeStatus({ currentAz: 90 });
    const { container, unmount } = render(createElement(RotatorPanel));
    const nBtn = container.querySelector(
      '[data-testid="rotator-preset-N"]',
    ) as HTMLButtonElement | null;
    expect(nBtn).not.toBeNull();
    act(() => {
      nBtn?.click();
    });
    expect(storeState.setAzimuth).toHaveBeenCalledTimes(1);
    expect(storeState.setAzimuth).toHaveBeenCalledWith(0);
    unmount();
  });

  it('clicking the E preset calls setAzimuth(90)', () => {
    storeState.status = makeStatus({ currentAz: 0 });
    const { container, unmount } = render(createElement(RotatorPanel));
    const btn = container.querySelector(
      '[data-testid="rotator-preset-E"]',
    ) as HTMLButtonElement | null;
    act(() => {
      btn?.click();
    });
    expect(storeState.setAzimuth).toHaveBeenCalledWith(90);
    unmount();
  });

  it('clicking Stop calls stop()', () => {
    storeState.status = makeStatus({ currentAz: 0, targetAz: 90, moving: true });
    const { container, unmount } = render(createElement(RotatorPanel));
    const stopBtn = container.querySelector(
      '[data-testid="rotator-stop"]',
    ) as HTMLButtonElement | null;
    expect(stopBtn).not.toBeNull();
    act(() => {
      stopBtn?.click();
    });
    expect(storeState.stop).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('manual input + GO submits the parsed azimuth', () => {
    storeState.status = makeStatus({ currentAz: 0 });
    const { container, unmount } = render(createElement(RotatorPanel));
    const input = container.querySelector(
      '[data-testid="rotator-manual-input"]',
    ) as HTMLInputElement | null;
    const go = container.querySelector('[data-testid="rotator-go"]') as HTMLButtonElement | null;
    expect(input).not.toBeNull();
    expect(go).not.toBeNull();

    // Set the value via React's input-event path so the onChange runs.
    act(() => {
      const proto = Object.getPrototypeOf(input!) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter?.call(input!, '215');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    act(() => {
      go?.click();
    });

    expect(storeState.setAzimuth).toHaveBeenCalledTimes(1);
    expect(storeState.setAzimuth).toHaveBeenCalledWith(215);
    unmount();
  });

  it('Enter in manual input submits the parsed azimuth', () => {
    storeState.status = makeStatus({ currentAz: 0 });
    const { container, unmount } = render(createElement(RotatorPanel));
    const input = container.querySelector(
      '[data-testid="rotator-manual-input"]',
    ) as HTMLInputElement | null;
    expect(input).not.toBeNull();

    act(() => {
      const proto = Object.getPrototypeOf(input!) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter?.call(input!, '45');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    act(() => {
      input!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
    });

    expect(storeState.setAzimuth).toHaveBeenCalledWith(45);
    unmount();
  });
});

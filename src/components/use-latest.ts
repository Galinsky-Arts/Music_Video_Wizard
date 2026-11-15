"use client";

import { useEffect, useRef } from "react";

/**
 * Keeps a stable ref to the most recent value (usually a callback) so that
 * polling/debounce effects can call the latest closure without being torn
 * down and recreated on every render.
 */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}

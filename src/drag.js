// Pointer dragging for sliders (seek, volume): calls onMove while dragging, onCommit on release,
// both with the 0–1 position along the element.
import { useRef } from 'react';

export function useDrag(onCommit, onMove) {
  const ref = useRef(null);
  const ratio = (e) => {
    const r = ref.current.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };
  const handlers = {
    onPointerDown: (e) => {
      ref.current.setPointerCapture(e.pointerId);
      onMove(ratio(e));
    },
    onPointerMove: (e) => ref.current.hasPointerCapture(e.pointerId) && onMove(ratio(e)),
    onPointerUp: (e) => {
      ref.current.releasePointerCapture(e.pointerId);
      onCommit(ratio(e));
    },
  };
  return [ref, handlers];
}

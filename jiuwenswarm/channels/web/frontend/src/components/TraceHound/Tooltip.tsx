import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { C } from './traceTokens';

/** Custom tooltip (browser title= is unreliable/slow). Shared across TraceHound
 *  components so SVG nodes and HTML cards render identical hover info. */
export function Tooltip({ text, children }: { text: string; children: React.ReactNode }) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  const handleEnter = (e: React.MouseEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setPos({ x: rect.left + rect.width / 2, y: rect.top });
    setShow(true);
  };

  const box = show && text ? (
    <div style={{
      position: 'fixed', top: pos.y - 8, left: pos.x, transform: 'translate(-50%, -100%)',
      background: C.text, color: C.surface, fontSize: 11, padding: '8px 10px',
      borderRadius: 6, whiteSpace: 'pre-wrap', zIndex: 2147483647, minWidth: 180, maxWidth: 300,
      boxShadow: '0 4px 16px rgba(0,0,0,0.35)', pointerEvents: 'none', lineHeight: 1.5,
    }}>
      {text}
      <div style={{ position: 'absolute', bottom: -5, left: '50%', transform: 'translateX(-50%)', width: 0, height: 0, borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderTop: `5px solid ${C.text}` }} />
    </div>
  ) : null;

  // If child is a React element, attach handlers directly — no wrapper.
  // This lets the child remain a direct flex item in its parent row.
  if (React.isValidElement(children)) {
    return (
      <>
        {React.cloneElement(children, {
          onMouseEnter: handleEnter,
          onMouseLeave: () => setShow(false),
        } as any)}
        {createPortal(box, document.body)}
      </>
    );
  }

  // For text / fragment children, fall back to a span wrapper
  return (
    <>
      <span
        style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
        onMouseEnter={handleEnter}
        onMouseLeave={() => setShow(false)}
      >
        {children}
      </span>
      {createPortal(box, document.body)}
    </>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

interface Selection {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

function App() {
  const [isSelecting, setIsSelecting] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const getSelectionRect = useCallback(() => {
    if (!selection) return null;
    const x = Math.min(selection.startX, selection.endX);
    const y = Math.min(selection.startY, selection.endY);
    const width = Math.abs(selection.endX - selection.startX);
    const height = Math.abs(selection.endY - selection.startY);
    return { x, y, width, height };
  }, [selection]);

  const handleMouseDown = (e: React.MouseEvent) => {
    setIsSelecting(true);
    setSelection({
      startX: e.clientX,
      startY: e.clientY,
      endX: e.clientX,
      endY: e.clientY,
    });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isSelecting || !selection) return;
    setSelection({
      ...selection,
      endX: e.clientX,
      endY: e.clientY,
    });
  };

  const handleMouseUp = async () => {
    if (!isSelecting || !selection) return;
    setIsSelecting(false);

    const rect = getSelectionRect();
    if (!rect || rect.width < 5 || rect.height < 5) {
      setSelection(null);
      return;
    }

    // Hide selection UI before capturing
    setSelection(null);

    // Wait for the UI to update and screen to refresh
    await new Promise((resolve) => setTimeout(resolve, 50));

    try {
      const scale = window.devicePixelRatio || 1;
      await invoke("capture_region", {
        region: {
          x: Math.round(rect.x * scale),
          y: Math.round(rect.y * scale),
          width: Math.round(rect.width * scale),
          height: Math.round(rect.height * scale),
        },
      });
    } catch (err) {
      console.error("Capture failed:", err);
    }

    await invoke("hide_overlay");
  };

  const handleKeyDown = useCallback(async (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      setIsSelecting(false);
      setSelection(null);
      await invoke("hide_overlay");
    }
  }, []);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const rect = getSelectionRect();

  return (
    <div
      ref={overlayRef}
      className="overlay"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {rect && rect.width > 0 && rect.height > 0 && (
        <>
          <div className="dim dim-top" style={{ height: rect.y }} />
          <div
            className="dim dim-left"
            style={{
              top: rect.y,
              height: rect.height,
              width: rect.x,
            }}
          />
          <div
            className="dim dim-right"
            style={{
              top: rect.y,
              height: rect.height,
              left: rect.x + rect.width,
              right: 0,
            }}
          />
          <div
            className="dim dim-bottom"
            style={{
              top: rect.y + rect.height,
              bottom: 0,
            }}
          />
          <div
            className="selection"
            style={{
              left: rect.x,
              top: rect.y,
              width: rect.width,
              height: rect.height,
            }}
          >
            <div className="dimensions">
              {Math.round(rect.width)} x {Math.round(rect.height)}
            </div>
          </div>
        </>
      )}
      {!selection && (
        <div className="instructions">
          Click and drag to select area. Press ESC to cancel.
        </div>
      )}
    </div>
  );
}

export default App;

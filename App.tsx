import { useEffect, useRef, useState, useCallback, MouseEvent as ReactMouseEvent, TouchEvent as ReactTouchEvent, useMemo } from "react";
import { io, Socket } from "socket.io-client";
import { Paintbrush, RotateCcw, Users, Undo2, Redo2, Sparkles, Zap, Palette, Link as LinkIcon, Component, Globe, Circle, MousePointer2, Camera } from "lucide-react";

type Effect = 'none' | 'neon' | 'glitter' | 'gradient';

interface DrawSegment {
  strokeId: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  color: string;
  lineWidth: number;
  effect: Effect;
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const socketRef = useRef<Socket | null>(null);

  const [roomId, setRoomId] = useState<string | null>(null);
  const [showSplash, setShowSplash] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(window.innerWidth > 768);
  const [cursors, setCursors] = useState<Record<string, { x: number, y: number, color: string, effect: string, ts: number }>>({});

  // Hoist redraw so it can be safely triggered by async sockets AND resize observers identically
  const redrawTriggerRef = useRef<() => void>(() => {});

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    if (roomParam) {
      setRoomId(roomParam);
      setShowSplash(false);
    } else {
      // Connect to global hub immediately so the background canvas renders
      setRoomId('kaleidoscope-shared');
      setShowSplash(true);
    }
  }, []);

  const [isDrawing, setIsDrawing] = useState(false);
  const [color, setColor] = useState("#3b82f6"); 
  const [lineWidth, setLineWidth] = useState(4);
  const [segments, setSegments] = useState(12);
  const [zoomSpeed, setZoomSpeed] = useState(0.5);
  const [rotationSpeed, setRotationSpeed] = useState(0.2);
  const [connectedUsers, setConnectedUsers] = useState(1);
  const [drawMode, setDrawMode] = useState<'free' | 'continuous'>('continuous');
  const [effect, setEffect] = useState<Effect>('none');
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const lastPos = useRef<{ x: number; y: number } | null>(null);
  const startTimeRef = useRef(Date.now());
  
  // Track pointer state for continuous render loop drawing
  const isDrawingRef = useRef(false);
  const currentScreenPosRef = useRef<{ x: number; y: number } | null>(null);
  const lastPhaseRef = useRef(0);
  const cursorThrottleRef = useRef(0);
  
  // Create refs for state to be used inside the rAF loop
  const colorRef = useRef(color); colorRef.current = color;
  const lineWidthRef = useRef(lineWidth); lineWidthRef.current = lineWidth;
  const roomIdRef = useRef(roomId); roomIdRef.current = roomId;
  const drawModeRef = useRef(drawMode); drawModeRef.current = drawMode;
  const effectRef = useRef(effect); effectRef.current = effect;

  // History state refs
  const allSegmentsRef = useRef<DrawSegment[]>([]);
  const myStrokeIdsRef = useRef<string[]>([]);
  const redoStackRef = useRef<{ id: string, segments: DrawSegment[] }[]>([]);
  const kalCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const kalNeedsUpdateRef = useRef<boolean>(true);

  const ensureSourceCanvas = useCallback(() => {
    if (!sourceCanvasRef.current) {
      const offscreen = document.createElement("canvas");
      const D = Math.max(window.innerWidth || 800, window.innerHeight || 600) * 1.5;
      offscreen.width = D;
      offscreen.height = D;
      sourceCanvasRef.current = offscreen;
    }
    return sourceCanvasRef.current;
  }, []);

  const ensureKalCanvas = useCallback(() => {
    if (!kalCanvasRef.current) {
      const offscreen = document.createElement("canvas");
      const D = Math.max(window.innerWidth || 800, window.innerHeight || 600) * 1.5;
      offscreen.width = D;
      offscreen.height = D;
      kalCanvasRef.current = offscreen;
    }
    return kalCanvasRef.current;
  }, []);
  const currentStrokeIdRef = useRef<string | null>(null);

  const updateHistoryState = useCallback(() => {
    setCanUndo(myStrokeIdsRef.current.length > 0);
    setCanRedo(redoStackRef.current.length > 0);
  }, []);

  const getSimTime = useCallback(() => {
    return (Date.now() - startTimeRef.current) / 1000;
  }, []);

  // Setup sockets
  useEffect(() => {
    if (!roomId) return;

    const socket = io({ path: "/socket.io" });
    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit("join-room", roomId);
    });

    socket.on("sync", (data: { segments: DrawSegment[] }) => {
      console.log("SYNC RECEIVED on Client!", data);
      allSegmentsRef.current = data.segments || [];
      
      // Bypass all React hooks and refs, execute immediately
      if (!sourceCanvasRef.current) {
        const offscreen = document.createElement("canvas");
        const D = Math.max(window.innerWidth || 800, window.innerHeight || 600) * 2;
        offscreen.width = D;
        offscreen.height = D;
        sourceCanvasRef.current = offscreen;
      }
      
      const performRedraw = () => {
        const source = ensureSourceCanvas();
        if (!source) return;
        const ctx = source.getContext("2d", { willReadFrequently: true });
        if (ctx) {
          ctx.clearRect(0, 0, source.width, source.height);
          allSegmentsRef.current.forEach(seg => {
            drawSegmentOnCtx(ctx, seg);
          });
        }
        kalNeedsUpdateRef.current = true;
      };

      // Perform immediately
      performRedraw();
      
      // Perform again after 500ms and 1500ms to guarantee any DOM/Render layout race conditions are forcefully crushed natively
      setTimeout(performRedraw, 500);
      setTimeout(performRedraw, 1500);
      
      redrawTriggerRef.current(); // Just in case it existed
    });

    socket.on("draw", (data: DrawSegment) => {
      handleRemoteDraw(data);
    });

    socket.on("undo", (data: { strokeId: string }) => {
      handleRemoteUndo(data.strokeId);
    });

    socket.on("clear", () => {
      clearSource();
    });

    socket.on("cursor", (data: { id: string, x: number, y: number, color: string, effect: string }) => {
      setCursors(prev => ({
        ...prev,
        [data.id]: { x: data.x, y: data.y, color: data.color, effect: data.effect, ts: Date.now() }
      }));
    });

    socket.on("user-count", (count) => {
      setConnectedUsers(count);
    });

    return () => {
      socket.disconnect();
    };
  }, [roomId]);

  // Cursor decay loop
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setCursors(prev => {
        const next = { ...prev };
        let changed = false;
        for (const [id, cursor] of Object.entries(next) as [string, { ts: number }][]) {
          if (now - cursor.ts > 2000) { // Decay after 2 seconds
            delete next[id];
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Setup canvas & render loop
  useEffect(() => {
    ensureSourceCanvas();

    const canvas = canvasRef.current;
    if (!canvas) return;

    // Initial resize trigger to build kalCanvas
    const handleResize = () => {
      canvas.width = window.innerWidth || 800;
      canvas.height = window.innerHeight || 600;
      
      const D = Math.max(window.innerWidth || 800, window.innerHeight || 600) * 1.5;
      
      if (sourceCanvasRef.current && sourceCanvasRef.current.width < D) {
         sourceCanvasRef.current.width = D;
         sourceCanvasRef.current.height = D;
      }
      if (kalCanvasRef.current && kalCanvasRef.current.width < D) {
         kalCanvasRef.current.width = D;
         kalCanvasRef.current.height = D;
      }
      
      redrawAllStrokes();
    };
    window.addEventListener("resize", handleResize);
    handleResize();

    let animationFrameId: number;

    const render = () => {
      const ctx = canvas.getContext("2d");
      const source = ensureSourceCanvas();
      const kalCanvas = ensureKalCanvas();
      if (!ctx || !source || !kalCanvas) return;

      const time = (Date.now() - startTimeRef.current) / 1000;
      
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      const scx = source.width / 2;
      const scy = source.height / 2;
      const sliceAngle = (Math.PI * 2) / segments;
      const clipRadius = Math.hypot(scx, scy);

      // Pre-render the mathematical kaleidoscope if any stroke invalidated it
      if (kalNeedsUpdateRef.current) {
        const kalCtx = kalCanvas.getContext("2d");
        if (kalCtx) {
          kalCtx.clearRect(0, 0, kalCanvas.width, kalCanvas.height);
          for (let i = 0; i < segments; i++) {
            kalCtx.save();
            kalCtx.translate(scx, scy);
            kalCtx.rotate(i * sliceAngle);
            
            kalCtx.beginPath();
            kalCtx.moveTo(0, 0);
            kalCtx.arc(0, 0, clipRadius, 0, sliceAngle);
            kalCtx.clip();
            
            if (i % 2 === 1) {
              kalCtx.rotate(sliceAngle);
              kalCtx.scale(1, -1);
            }
            
            kalCtx.drawImage(source, -scx, -scy);
            kalCtx.restore();
          }
        }
        kalNeedsUpdateRef.current = false;
      }
      
      // Clear main canvas with dark background
      ctx.fillStyle = "#0f172a";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Draw Depth Layers
      ctx.save();
      ctx.translate(cx, cy);

      const numLayers = 6;
      const timePhase = (time * zoomSpeed) % 1;
      
      // Draw layers recursively from deep (smallest) to close (largest) 
      for (let layer = numLayers - 1; layer >= -1; layer--) {
        const power = layer - timePhase;
        const scale = Math.pow(1.5, -power);
        
        ctx.save();
        ctx.scale(scale, scale);
        
        // Fade extremes smoothly
        if (layer === -1) {
           ctx.globalAlpha = 1 - timePhase;
        } else if (layer === numLayers - 1) {
           ctx.globalAlpha = timePhase;
        } else {
           ctx.globalAlpha = 1;
        }
        
        // Single rotational phase applied identically across all scales
        ctx.rotate(time * rotationSpeed);
        ctx.drawImage(kalCanvas, -scx, -scy);
        ctx.restore();
      }
      
      ctx.restore();

      // Continuous draw loop
      if (isDrawingRef.current && currentScreenPosRef.current && lastPos.current && drawModeRef.current === 'continuous' && currentStrokeIdRef.current) {
        const newPos = getMappedCoords(currentScreenPosRef.current.x, currentScreenPosRef.current.y);
        const x0 = lastPos.current.x;
        const y0 = lastPos.current.y;
        const x1 = newPos.x;
        const y1 = newPos.y;
        
        const dx = x1 - x0;
        const dy = y1 - y0;
        
        const isRollover = (lastPhaseRef.current > 0.8 && timePhase < 0.2) || (lastPhaseRef.current < 0.2 && timePhase > 0.8);

        // Break stroke if jumping caused by loop rollover
        if (isRollover) {
          lastPos.current = newPos;
        } else if (Math.abs(dx) > 2.0 || Math.abs(dy) > 2.0) {
          const seg: DrawSegment = {
            strokeId: currentStrokeIdRef.current,
            x0, y0, x1, y1,
            color: colorRef.current,
            lineWidth: lineWidthRef.current,
            effect: effectRef.current
          };
          
          addSegmentLocally(seg);
          socketRef.current?.emit("draw", { roomId: roomIdRef.current, ...seg });
          
          lastPos.current = newPos;
        }
      }

      lastPhaseRef.current = timePhase;
      
      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      window.removeEventListener("resize", handleResize);
      cancelAnimationFrame(animationFrameId);
    };
  }, [segments, rotationSpeed, zoomSpeed]);

  const redrawAllStrokes = useCallback(() => {
    const source = ensureSourceCanvas();
    const ctx = source.getContext("2d");
    if (!ctx) return;
    
    ctx.clearRect(0, 0, source.width, source.height);
    
    // Redraw in exact chronological order
    allSegmentsRef.current.forEach(seg => {
      drawSegmentOnCtx(ctx, seg);
    });
    
    kalNeedsUpdateRef.current = true;
  }, [ensureSourceCanvas]);

  useEffect(() => {
    redrawTriggerRef.current = redrawAllStrokes;
  }, [redrawAllStrokes]);

  const addSegmentLocally = (seg: DrawSegment) => {
    allSegmentsRef.current.push(seg);
    
    const source = ensureSourceCanvas();
    const ctx = source.getContext("2d");
    if (ctx) drawSegmentOnCtx(ctx, seg);
    kalNeedsUpdateRef.current = true;
  };

  const handleRemoteDraw = (seg: DrawSegment) => {
    addSegmentLocally(seg);
  };

  const handleRemoteUndo = (strokeId: string) => {
    allSegmentsRef.current = allSegmentsRef.current.filter(seg => seg.strokeId !== strokeId);
    redrawTriggerRef.current();
  };

  const drawSegmentOnCtx = (ctx: CanvasRenderingContext2D, seg: DrawSegment) => {
    const scx = ctx.canvas.width / 2;
    const scy = ctx.canvas.height / 2;
    
    const x0 = scx + seg.x0;
    const y0 = scy + seg.y0;
    const x1 = scx + seg.x1;
    const y1 = scy + seg.y1;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    
    if (seg.effect === 'neon') {
      ctx.shadowBlur = seg.lineWidth * 2.5;
      ctx.shadowColor = seg.color;
      ctx.strokeStyle = '#ffffff'; 
    } else if (seg.effect === 'gradient') {
      const grad = ctx.createLinearGradient(x0, y0, x1, y1);
      grad.addColorStop(0, seg.color);
      grad.addColorStop(1, '#ffffff');
      ctx.strokeStyle = grad;
    } else {
      ctx.strokeStyle = seg.color;
    }
    
    ctx.lineWidth = seg.lineWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();

    if (seg.effect === 'glitter') {
      const dx = x1 - x0;
      const dy = y1 - y0;
      const dist = Math.hypot(dx, dy);
      const steps = Math.max(1, Math.floor(dist / Math.max(2, seg.lineWidth * 0.5)));
      
      ctx.fillStyle = '#ffffff';
      for (let i = 0; i <= steps; i++) {
         const t = i / steps;
         const pseudoRandomX = Math.abs(Math.sin((seg.x0 + i) * 12.9898 + (seg.y0 + i) * 78.233)) % 1;
         const pseudoRandomY = Math.abs(Math.sin((seg.x0 + i) * 78.233 + (seg.y0 + i) * 12.9898)) % 1;
         
         const x = x0 + dx * t + (pseudoRandomX - 0.5) * seg.lineWidth * 3;
         const y = y0 + dy * t + (pseudoRandomY - 0.5) * seg.lineWidth * 3;
         const s = pseudoRandomX * (seg.lineWidth * 0.6) + 0.5;
         
         ctx.beginPath();
         ctx.arc(x, y, s, 0, Math.PI*2);
         ctx.fill();
      }
    }
    ctx.restore();
  };

  const clearSource = () => {
    const source = ensureSourceCanvas();
    const ctx = source.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, source.width, source.height);
    allSegmentsRef.current = [];
    myStrokeIdsRef.current = [];
    redoStackRef.current = [];
    kalNeedsUpdateRef.current = true;
    updateHistoryState();
  };

  const emitClear = () => {
    clearSource();
    if (socketRef.current && roomId) {
      socketRef.current.emit("clear", roomId);
    }
  };
  
  const handleUndo = () => {
    const lastMyId = myStrokeIdsRef.current.pop();
    if (lastMyId && roomId) {
      const removedSegs = allSegmentsRef.current.filter(s => s.strokeId === lastMyId);
      redoStackRef.current.push({ id: lastMyId, segments: removedSegs });
      
      allSegmentsRef.current = allSegmentsRef.current.filter(seg => seg.strokeId !== lastMyId);
      
      socketRef.current?.emit("undo", { roomId, strokeId: lastMyId });
      redrawTriggerRef.current();
      updateHistoryState();
    }
  };

  const handleRedo = () => {
    const restoredStr = redoStackRef.current.pop();
    if (restoredStr && roomId) {
       myStrokeIdsRef.current.push(restoredStr.id);
       allSegmentsRef.current.push(...restoredStr.segments);
       
       // Quickly re-emit all restored segments
       restoredStr.segments.forEach(seg => {
           socketRef.current?.emit("draw", { roomId, ...seg });
       });
       
       redrawAllStrokes();
       updateHistoryState();
    }
  };

  const getMappedCoords = (screenX: number, screenY: number) => {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const dx = screenX - cx;
    const dy = screenY - cy;
    
    let r = Math.sqrt(dx * dx + dy * dy);
    let theta = Math.atan2(dy, dx);
    
    const time = getSimTime();
    const R = time * rotationSpeed;
    const timePhase = (time * zoomSpeed) % 1;
    const S = Math.pow(1.5, timePhase);
    
    // Inverse scale and rotation
    r = r / S;
    theta = theta - R;
    
    // Map to primary wedge
    const sliceAngle = (Math.PI * 2) / segments;
    theta = ((theta % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    
    let slice = Math.floor(theta / sliceAngle);
    let thetaWedge = theta % sliceAngle;
    
    if (slice % 2 === 1) {
      thetaWedge = sliceAngle - thetaWedge;
    }
    
    // Return relative to the mathematical center (0,0)
    const srcX = r * Math.cos(thetaWedge);
    const srcY = r * Math.sin(thetaWedge);
    
    return { x: srcX, y: srcY };
  };

  const getScreenCoordsFromMapped = (srcX: number, srcY: number) => {
    // Reverse the transformation to find where on the screen a source coordinate is
    // NOTE: This will only pick one instance of the reflected point to render the cursor at, 
    // rather than all copies, which is perfect for showing the raw "ghost pen" location.
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    
    let r = Math.sqrt(srcX * srcX + srcY * srcY);
    let thetaWedge = Math.atan2(srcY, srcX);
    
    const time = getSimTime();
    const R = time * rotationSpeed;
    const timePhase = (time * zoomSpeed) % 1;
    const S = Math.pow(1.5, timePhase);
    
    // Apply scale and rotation forward
    r = r * S;
    let theta = thetaWedge + R;
    
    const screenX = cx + r * Math.cos(theta);
    const screenY = cy + r * Math.sin(theta);
    
    return { x: screenX, y: screenY };
  };

  const handlePointerDown = (clientX: number, clientY: number) => {
    isDrawingRef.current = true;
    currentScreenPosRef.current = { x: clientX, y: clientY };
    lastPhaseRef.current = Date.now(); // Used for cursor throttling when moving
    
    // Start a new local stroke and reset redo history upon drawing new line
    currentStrokeIdRef.current = Math.random().toString(36).substring(2, 9);
    myStrokeIdsRef.current.push(currentStrokeIdRef.current);
    redoStackRef.current = []; // Break redo history branching
    updateHistoryState();
    
    const pos = getMappedCoords(clientX, clientY);
    lastPos.current = { x: pos.x, y: pos.y };
  };

  const handlePointerMove = (clientX: number, clientY: number) => {
    // Emit ghost cursor
    if (socketRef.current && roomIdRef.current) {
      if (!cursorThrottleRef.current || (Date.now() - cursorThrottleRef.current > 30)) {
        // use cursorThrottleRef as throttling timer for mouse movements
        cursorThrottleRef.current = Date.now(); 
        const mapped = getMappedCoords(clientX, clientY);
        socketRef.current.volatile.emit("cursor", { 
          roomId: roomIdRef.current, 
          x: mapped.x, 
          y: mapped.y, 
          color: colorRef.current,
          effect: effectRef.current
        });
      }
    }

    if (!isDrawingRef.current) return;
    
    currentScreenPosRef.current = { x: clientX, y: clientY };
    
    if (drawModeRef.current === 'free' && lastPos.current && currentStrokeIdRef.current) {
      const timePhase = (getSimTime() * zoomSpeed) % 1;
      const newPos = getMappedCoords(clientX, clientY);
      const x0 = lastPos.current.x;
      const y0 = lastPos.current.y;
      const x1 = newPos.x;
      const y1 = newPos.y;

      const dx = x1 - x0;
      const dy = y1 - y0;
      const dist = Math.hypot(dx, dy);
      
      const isRollover = (lastPhaseRef.current > 0.8 && timePhase < 0.2) || (lastPhaseRef.current < 0.2 && timePhase > 0.8);

      // Ensure snap jumps don't draw lines
      if (isRollover || dist > sourceCanvasRef.current!.width * 0.2) {
        lastPos.current = newPos;
      } else if (dist > 2.0) {
        const seg: DrawSegment = {
          strokeId: currentStrokeIdRef.current,
          x0, y0, x1, y1,
          color,
          lineWidth,
          effect
        };
        
        addSegmentLocally(seg);

        socketRef.current?.emit("draw", {
          roomId: roomIdRef.current,
          ...seg
        });

        lastPos.current = newPos;
      }
    }
  };

  const handlePointerUp = () => {
    isDrawingRef.current = false;
    currentScreenPosRef.current = null;
    lastPos.current = null;
    currentStrokeIdRef.current = null;
  };

  const joinGlobal = () => {
    window.history.pushState({}, '', window.location.pathname);
    setRoomId("kaleidoscope-shared");
    setShowSplash(false);
  };

  const createPrivate = () => {
    const randomId = Math.random().toString(36).substring(2, 10);
    window.history.pushState({}, '', `?room=${randomId}`);
    setRoomId(randomId);
    clearSource();
    setShowSplash(false);
  };

  const copyShareLink = () => {
    const url = window.location.href;
    navigator.clipboard.writeText(url).then(() => {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    });
  };

  const takeSnapshot = () => {
    const canvas = canvasRef.current;
    if (!canvas || canvas.width === 0 || canvas.height === 0) return;
    
    // Create an offscreen canvas to combine the black background and the transparent fractal
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = canvas.width;
    exportCanvas.height = canvas.height;
    const ctx = exportCanvas.getContext('2d');
    if (!ctx) return;
    
    // Draw black background
    ctx.fillStyle = '#050505';
    ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
    // Draw kaleidoscope
    ctx.drawImage(canvas, 0, 0);

    const data = exportCanvas.toDataURL("image/png");
    const link = document.createElement("a");
    link.download = `kaleidosync-${Math.random().toString(36).substring(2, 8)}.png`;
    link.href = data;
    link.click();
  };

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#050505] font-sans text-neutral-100"> 
      <canvas
        ref={canvasRef}
        className="absolute inset-0 cursor-crosshair touch-none"
        onMouseDown={(e) => handlePointerDown(e.clientX, e.clientY)}
        onMouseMove={(e) => handlePointerMove(e.clientX, e.clientY)}
        onMouseUp={handlePointerUp}
        onMouseOut={handlePointerUp}
        onTouchStart={(e) => {
          const touch = e.touches[0];
          handlePointerDown(touch.clientX, touch.clientY);
        }}
        onTouchMove={(e) => {
          const touch = e.touches[0];
          handlePointerMove(touch.clientX, touch.clientY);
        }}
        onTouchEnd={handlePointerUp}
      />
      
      {/* Ghost Cursors Overlays */}
      {!showSplash && Object.entries(cursors).map(([id, cursor]: [string, any]) => {
        const screenPos = getScreenCoordsFromMapped(cursor.x, cursor.y);
        // Only render if roughly onscreen
        if (screenPos.x < -100 || screenPos.x > window.innerWidth + 100) return null;
        return (
          <div 
            key={id}
            className="absolute z-10 pointer-events-none transition-all duration-[30ms] ease-linear flex flex-col items-center gap-1"
            style={{ 
              left: screenPos.x, 
              top: screenPos.y,
              transform: 'translate(-50%, -50%)'
            }}
          >
            <div 
              className="w-3 h-3 rounded-full border border-white/50 animate-pulse"
              style={{ 
                backgroundColor: cursor.color,
                boxShadow: cursor.effect === 'neon' ? `0 0 10px ${cursor.color}` : 'none'
              }}
            />
            <span className="text-[9px] font-mono font-bold tracking-widest uppercase bg-[#0a0a0a]/80 text-white/50 px-1.5 py-0.5 rounded-sm">
              GUEST
            </span>
          </div>
        );
      })}

      {showSplash && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-[#0a0a0a]/60 backdrop-blur-md p-6 pointer-events-auto">
          <div className="flex flex-col max-w-md w-full bg-[#0a0a0a]/90 border border-neutral-800 p-8 rounded-3xl shadow-2xl">
            <h1 className="text-4xl font-medium tracking-tighter mb-4 text-white">
              Kaleidosync.
            </h1>
            <p className="text-sm text-neutral-400 mb-8 leading-relaxed max-w-sm">
              Welcome to the void! Paint in infinite reflection with friends, or jump into the ever-evolving global hub right now.
            </p>

            <div className="flex flex-col w-full gap-4">
              <button 
                onClick={joinGlobal}
                className="group relative flex items-center justify-center gap-4 w-full bg-white hover:bg-neutral-200 text-black border border-transparent p-4 rounded-xl transition-all duration-300"
              >
                <div className="flex flex-col items-start text-left flex-1">
                  <span className="font-semibold text-sm">Join Global Hub</span>
                  <span className="text-[11px] text-neutral-600 font-medium">Draw with everyone online</span>
                </div>
                <Globe size={18} className="text-black group-hover:scale-110 transition-transform" />
              </button>

              <button 
                onClick={createPrivate}
                className="group relative flex items-center justify-center gap-4 w-full bg-transparent hover:bg-neutral-900 border border-neutral-800 hover:border-neutral-700 p-4 rounded-xl transition-all duration-300"
              >
                <div className="flex flex-col items-start text-left flex-1">
                  <span className="font-semibold text-sm text-neutral-200">Create Private Room</span>
                  <span className="text-[11px] text-neutral-500 font-medium">Generate a unique invite link</span>
                </div>
                <Component size={18} className="text-neutral-400 group-hover:scale-110 transition-transform" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mobile Menu Toggle Button */}
      {!showSplash && !isMenuOpen && (
        <button 
          onClick={() => setIsMenuOpen(true)}
          className="absolute z-40 top-6 left-6 p-4 rounded-xl bg-[#0a0a0a]/90 backdrop-blur-xl border border-neutral-800 text-white shadow-2xl hover:scale-105 active:scale-95 transition-all outline-none"
        >
          <Palette size={20} />
        </button>
      )}

      {/* UI Overlay */}
      {!showSplash && isMenuOpen && (
        <div className="absolute z-40 top-4 left-4 sm:top-6 sm:left-6 bottom-4 sm:bottom-auto max-h-[calc(100dvh-32px)] sm:max-h-[calc(100dvh-48px)] w-[calc(100%-32px)] sm:w-auto overflow-y-auto bg-[#0a0a0a]/90 backdrop-blur-xl p-5 rounded-2xl border border-neutral-800 shadow-2xl flex flex-col gap-6 max-w-[280px] pointer-events-auto hide-scrollbar">
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between pointer-events-auto">
            <h1 className="text-xl font-medium tracking-tighter text-white">
              Kaleidosync
            </h1>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5 text-xs font-mono text-neutral-400 bg-neutral-900 px-2 py-1 rounded-md border border-neutral-800">
                <Users size={12} className="text-neutral-500" />
                <span>{connectedUsers}</span>
              </div>
              <button 
                onClick={() => setIsMenuOpen(false)}
                className="text-neutral-500 hover:text-white transition-colors"
                aria-label="Close menu"
              >
                <RotateCcw size={14} className="rotate-45" /> {/* Makes a simple X shape */}
              </button>
            </div>
          </div>
          
          <div className="flex justify-between items-center bg-neutral-900/50 p-1.5 pl-3 rounded-lg border border-neutral-800/50">
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-neutral-300 animate-pulse" />
              <span className="text-[10px] font-mono text-neutral-400 tracking-widest uppercase">
                {roomId === 'kaleidoscope-shared' ? 'Global' : 'Private'}
              </span>
            </div>
            
            <div className="relative">
              <button 
                onClick={copyShareLink}
                className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md bg-white hover:bg-neutral-200 text-black transition-colors text-[10px] font-semibold uppercase tracking-wider"
              >
                <LinkIcon size={10} />
                Copy
              </button>
              {isCopied && (
                <div className="absolute top-full mt-2 right-0 bg-white text-black text-[10px] uppercase font-bold tracking-wider py-1 px-2 rounded-sm shadow-lg animate-in fade-in slide-in-from-top-1 min-w-max">
                  Copied
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex gap-2 w-full">
          <button 
            onClick={handleUndo} disabled={!canUndo}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg border transition-all text-xs font-medium uppercase tracking-wider ${canUndo ? 'bg-neutral-900 border-neutral-700 text-neutral-200 hover:bg-neutral-800' : 'bg-transparent border-neutral-800/50 text-neutral-600 cursor-not-allowed'}`}
          >
            <Undo2 size={14} /> Undo
          </button>
          <button 
            onClick={handleRedo} disabled={!canRedo}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg border transition-all text-xs font-medium uppercase tracking-wider ${canRedo ? 'bg-neutral-900 border-neutral-700 text-neutral-200 hover:bg-neutral-800' : 'bg-transparent border-neutral-800/50 text-neutral-600 cursor-not-allowed'}`}
          >
            <Redo2 size={14} /> Redo
          </button>
        </div>

        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-3">
            <span className="text-[10px] font-medium text-neutral-500 uppercase tracking-widest">Brush Style</span>
            <div className="flex bg-neutral-900 p-1 rounded-lg border border-neutral-800">
              <button 
                onClick={() => setDrawMode('free')}
                className={`flex-1 flex items-center justify-center gap-1.5 text-[11px] font-medium py-1.5 rounded-md transition-all ${drawMode === 'free' ? 'bg-neutral-700 text-white shadow-sm' : 'text-neutral-500 hover:text-neutral-300'}`}
              >
                <MousePointer2 size={12} /> Free
              </button>
              <button 
                onClick={() => setDrawMode('continuous')}
                className={`flex-1 flex items-center justify-center gap-1.5 text-[11px] font-medium py-1.5 rounded-md transition-all ${drawMode === 'continuous' ? 'bg-neutral-700 text-white shadow-sm' : 'text-neutral-500 hover:text-neutral-300'}`}
              >
                <RotateCcw size={12} /> Auto
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex justify-between items-center">
              <span className="text-[10px] font-medium text-neutral-500 uppercase tracking-widest">Thickness</span>
            </div>
            <input 
              type="range" min="1" max="24" step="1"
              value={lineWidth}
              onChange={(e) => setLineWidth(parseInt(e.target.value))}
              className="w-full h-1 bg-neutral-800 rounded-full appearance-none cursor-pointer accent-white"
            />
          </div>

          <div className="flex flex-col gap-3">
            <span className="text-[10px] font-medium text-neutral-500 uppercase tracking-widest">Line Effect</span>
            <div className="grid grid-cols-2 gap-1.5">
              {[
                { id: 'none', label: 'Solid', icon: Paintbrush },
                { id: 'neon', label: 'Glow', icon: Zap },
                { id: 'glitter', label: 'Dust', icon: Sparkles },
                { id: 'gradient', label: 'Gradient', icon: Palette }
              ].map(opt => (
                <button
                  key={opt.id}
                  onClick={() => setEffect(opt.id as Effect)}
                  className={`flex items-center gap-1.5 px-2 py-2 rounded-lg border text-[11px] font-medium transition-all ${effect === opt.id ? 'bg-white border-white text-black' : 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'}`}
                >
                  <opt.icon size={12} />
                  <span>{opt.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex justify-between items-center">
              <span className="text-[10px] font-medium text-neutral-500 uppercase tracking-widest">Color</span>
              <span className="text-[10px] font-mono text-neutral-500">{color}</span>
            </div>
            
            <div className="flex items-center gap-2">
              <div 
                className="relative w-10 h-10 rounded-lg overflow-hidden border border-neutral-700 shrink-0 cursor-pointer shadow-inner transition-transform hover:scale-105"
                style={{ backgroundColor: color }}
              >
                <input 
                  type="color" 
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="absolute -inset-4 w-[200%] h-[200%] opacity-0 cursor-pointer"
                />
              </div>
              <div className="flex gap-2 flex-1 items-center px-1">
                {['#ffffff', '#ff3366', '#33ccff', '#ccff00'].map(c => (
                  <button
                    key={c}
                    onClick={() => setColor(c)}
                    className={`w-6 h-6 rounded-full transition-transform hover:scale-110 active:scale-95 ${color === c ? 'ring-1 ring-white ring-offset-2 ring-offset-[#0a0a0a] border-none' : 'border border-neutral-700'}`}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex justify-between items-center">
              <span className="text-[10px] font-medium text-neutral-500 uppercase tracking-widest">Mirrors</span>
              <span className="text-[10px] font-mono text-neutral-400">{segments}</span>
            </div>
            <input 
              type="range" min="2" max="24" step="2"
              value={segments}
              onChange={(e) => setSegments(parseInt(e.target.value))}
              className="w-full h-1 bg-neutral-800 rounded-full appearance-none cursor-pointer accent-white"
            />
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex justify-between items-center">
              <span className="text-[10px] font-medium text-neutral-500 uppercase tracking-widest">Zoom Speed</span>
            </div>
            <input 
              type="range" min="0.1" max="1.5" step="0.1"
              value={zoomSpeed}
              onChange={(e) => setZoomSpeed(parseFloat(e.target.value))}
              className="w-full h-1 bg-neutral-800 rounded-full appearance-none cursor-pointer accent-white"
            />
          </div>
          
          <div className="flex flex-col gap-3">
            <div className="flex justify-between items-center">
              <span className="text-[10px] font-medium text-neutral-500 uppercase tracking-widest">Rotation</span>
            </div>
            <input 
              type="range" min="0" max="1" step="0.05"
              value={rotationSpeed}
              onChange={(e) => setRotationSpeed(parseFloat(e.target.value))}
              className="w-full h-1 bg-neutral-800 rounded-full appearance-none cursor-pointer accent-white"
            />
          </div>
        </div>

        <div className="flex gap-2 w-full mt-2">
          <button 
            onClick={takeSnapshot}
            className="flex-1 flex items-center justify-center gap-2 py-3 px-4 bg-white hover:bg-neutral-200 text-black text-[11px] font-bold tracking-wider uppercase transition-colors rounded-lg border border-transparent shadow-[0_0_20px_rgba(255,255,255,0.1)]"
          >
            <Camera size={14} />
            Capture Art
          </button>
          {roomId !== 'kaleidoscope-shared' && (
            <button 
              onClick={emitClear}
              className="flex items-center justify-center gap-2 py-3 px-4 bg-transparent hover:bg-red-500/10 text-red-400 hover:text-red-300 text-[11px] font-bold tracking-wider uppercase transition-colors rounded-lg border border-red-500/20 hover:border-red-500/30"
            >
              <RotateCcw size={14} />
            </button>
          )}
        </div>
      </div>
      )}
    </div>
  );
}


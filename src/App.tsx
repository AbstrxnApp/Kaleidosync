import { useEffect, useRef, useState, useCallback, MouseEvent as ReactMouseEvent, TouchEvent as ReactTouchEvent, useMemo } from "react";
import { io, Socket } from "socket.io-client";
import { Paintbrush, RotateCcw, Users, Undo2, Redo2, Sparkles, Zap, Palette, Link as LinkIcon, Component, Globe, Circle, MousePointer2 } from "lucide-react";

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
  const [isCopied, setIsCopied] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    if (roomParam) {
      setRoomId(roomParam);
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
  
  // Create refs for state to be used inside the rAF loop
  const colorRef = useRef(color); colorRef.current = color;
  const lineWidthRef = useRef(lineWidth); lineWidthRef.current = lineWidth;
  const roomIdRef = useRef(roomId); roomIdRef.current = roomId;
  const drawModeRef = useRef(drawMode); drawModeRef.current = drawMode;
  const effectRef = useRef(effect); effectRef.current = effect;

  // History state refs
  const strokeOrderRef = useRef<string[]>([]);
  const strokesMapRef = useRef<Map<string, DrawSegment[]>>(new Map());
  const myStrokeIdsRef = useRef<string[]>([]);
  const redoStackRef = useRef<{ id: string, segments: DrawSegment[] }[]>([]);
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

    socket.on("draw", (data: DrawSegment) => {
      handleRemoteDraw(data);
    });

    socket.on("undo", (data: { strokeId: string }) => {
      handleRemoteUndo(data.strokeId);
    });

    socket.on("clear", () => {
      clearSource();
    });

    socket.on("user-count", (count) => {
      setConnectedUsers(count);
    });

    return () => {
      socket.disconnect();
    };
  }, [roomId]);

  // Setup canvas & render loop
  useEffect(() => {
    if (!sourceCanvasRef.current) {
      const offscreen = document.createElement("canvas");
      const D = Math.max(window.innerWidth, window.innerHeight) * 2;
      offscreen.width = D;
      offscreen.height = D;
      sourceCanvasRef.current = offscreen;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleResize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      
      if (sourceCanvasRef.current) {
        const offscreen = sourceCanvasRef.current;
        const D = Math.max(window.innerWidth, window.innerHeight) * 2;
        
        if (offscreen.width < D) {
          const temp = document.createElement("canvas");
          temp.width = offscreen.width;
          temp.height = offscreen.height;
          temp.getContext("2d")?.drawImage(offscreen, 0, 0);
          
          offscreen.width = D;
          offscreen.height = D;
          offscreen.getContext("2d")?.drawImage(temp, (D - temp.width)/2, (D - temp.height)/2);
        }
      }
    };
    window.addEventListener("resize", handleResize);
    handleResize();

    let animationFrameId: number;

    const render = () => {
      const ctx = canvas.getContext("2d");
      const source = sourceCanvasRef.current;
      if (!ctx || !source) return;

      const time = getSimTime();
      
      // Clear main canvas with dark background
      ctx.fillStyle = "#0f172a";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const cx = canvas.width / 2;
      const cy = canvas.height / 2;

      // Draw Layers
      ctx.save();
      ctx.translate(cx, cy);

      const sliceAngle = (Math.PI * 2) / segments;
      const clipRadius = Math.hypot(canvas.width, canvas.height);
      
      for (let i = 0; i < segments; i++) {
        ctx.save();
        ctx.rotate(i * sliceAngle + time * rotationSpeed);
        
        // Clip to pie slice FIRST
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, clipRadius, 0, sliceAngle);
        ctx.closePath();
        ctx.clip();
        
        // Mirror alternating segments
        if (i % 2 === 1) {
          ctx.rotate(sliceAngle);
          ctx.scale(1, -1);
        }
        
        const numLayers = 6;
        const timePhase = (time * zoomSpeed) % 1;
        
        // Draw layers recursively from deep (smallest) to close (largest) 
        // to ensure smaller rings do not occlude larger strokes.
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
          
          const scx = source.width / 2;
          const scy = source.height / 2;
          ctx.drawImage(source, -scx, -scy);
          ctx.restore();
        }
        ctx.restore();
      }

      // Continuous draw loop: if the pointer is pressed down but stationary, 
      // it should draw a continuous line because the canvas is rotating underneath it.
      if (isDrawingRef.current && currentScreenPosRef.current && lastPos.current && drawModeRef.current === 'continuous' && currentStrokeIdRef.current) {
        const timePhase = (time * zoomSpeed) % 1;
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
        } else if (Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05) {
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

      const timePhase = (time * zoomSpeed) % 1;
      lastPhaseRef.current = timePhase;
      
      ctx.restore();
      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      window.removeEventListener("resize", handleResize);
      cancelAnimationFrame(animationFrameId);
    };
  }, [segments, rotationSpeed, zoomSpeed]);

  const redrawAllStrokes = () => {
    const source = sourceCanvasRef.current;
    if (!source) return;
    const ctx = source.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, source.width, source.height);
    
    // Redraw in exact order
    strokeOrderRef.current.forEach(strokeId => {
      const segments = strokesMapRef.current.get(strokeId) || [];
      segments.forEach(seg => {
        drawSegmentOnCtx(ctx, seg);
      });
    });
  };

  const addSegmentLocally = (seg: DrawSegment) => {
    if (!strokesMapRef.current.has(seg.strokeId)) {
      strokesMapRef.current.set(seg.strokeId, []);
      strokeOrderRef.current.push(seg.strokeId);
    }
    strokesMapRef.current.get(seg.strokeId)!.push(seg);
    
    const source = sourceCanvasRef.current;
    if (source) {
      const ctx = source.getContext("2d");
      if (ctx) drawSegmentOnCtx(ctx, seg);
    }
  };

  const handleRemoteDraw = (seg: DrawSegment) => {
    addSegmentLocally(seg);
  };

  const handleRemoteUndo = (strokeId: string) => {
    if (strokesMapRef.current.has(strokeId)) {
      strokesMapRef.current.delete(strokeId);
      strokeOrderRef.current = strokeOrderRef.current.filter(id => id !== strokeId);
      redrawAllStrokes();
    }
  };

  const drawSegmentOnCtx = (ctx: CanvasRenderingContext2D, seg: DrawSegment) => {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(seg.x0, seg.y0);
    ctx.lineTo(seg.x1, seg.y1);
    
    if (seg.effect === 'neon') {
      ctx.shadowBlur = seg.lineWidth * 2.5;
      ctx.shadowColor = seg.color;
      ctx.strokeStyle = '#ffffff'; 
    } else if (seg.effect === 'gradient') {
      const grad = ctx.createLinearGradient(seg.x0, seg.y0, seg.x1, seg.y1);
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
      const dx = seg.x1 - seg.x0;
      const dy = seg.y1 - seg.y0;
      const dist = Math.hypot(dx, dy);
      const steps = Math.max(1, Math.floor(dist / Math.max(2, seg.lineWidth * 0.5)));
      
      ctx.fillStyle = '#ffffff';
      for (let i = 0; i <= steps; i++) {
         const t = i / steps;
         const pseudoRandomX = Math.abs(Math.sin((seg.x0 + i) * 12.9898 + (seg.y0 + i) * 78.233)) % 1;
         const pseudoRandomY = Math.abs(Math.sin((seg.x0 + i) * 78.233 + (seg.y0 + i) * 12.9898)) % 1;
         
         const x = seg.x0 + dx * t + (pseudoRandomX - 0.5) * seg.lineWidth * 3;
         const y = seg.y0 + dy * t + (pseudoRandomY - 0.5) * seg.lineWidth * 3;
         const s = pseudoRandomX * (seg.lineWidth * 0.6) + 0.5;
         
         ctx.beginPath();
         ctx.arc(x, y, s, 0, Math.PI*2);
         ctx.fill();
      }
    }
    ctx.restore();
  };

  const clearSource = () => {
    const source = sourceCanvasRef.current;
    if (!source) return;
    const ctx = source.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, source.width, source.height);
    strokesMapRef.current.clear();
    strokeOrderRef.current = [];
    myStrokeIdsRef.current = [];
    redoStackRef.current = [];
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
      const segments = strokesMapRef.current.get(lastMyId) || [];
      redoStackRef.current.push({ id: lastMyId, segments });
      
      strokesMapRef.current.delete(lastMyId);
      strokeOrderRef.current = strokeOrderRef.current.filter(id => id !== lastMyId);
      
      socketRef.current?.emit("undo", { roomId, strokeId: lastMyId });
      redrawAllStrokes();
      updateHistoryState();
    }
  };

  const handleRedo = () => {
    const restoredStr = redoStackRef.current.pop();
    if (restoredStr && roomId) {
       myStrokeIdsRef.current.push(restoredStr.id);
       strokesMapRef.current.set(restoredStr.id, restoredStr.segments);
       strokeOrderRef.current.push(restoredStr.id);
       
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
    
    const sourceCanvas = sourceCanvasRef.current;
    const scx = sourceCanvas ? sourceCanvas.width / 2 : cx;
    const scy = sourceCanvas ? sourceCanvas.height / 2 : cy;
    
    const srcX = scx + r * Math.cos(thetaWedge);
    const srcY = scy + r * Math.sin(thetaWedge);
    
    return { x: srcX, y: srcY };
  }; // Moved getMappedCoords out from below state for loop access

  const handlePointerDown = (clientX: number, clientY: number) => {
    isDrawingRef.current = true;
    currentScreenPosRef.current = { x: clientX, y: clientY };
    
    // Start a new local stroke and reset redo history upon drawing new line
    currentStrokeIdRef.current = Math.random().toString(36).substring(2, 9);
    myStrokeIdsRef.current.push(currentStrokeIdRef.current);
    redoStackRef.current = []; // Break redo history branching
    updateHistoryState();
    
    const pos = getMappedCoords(clientX, clientY);
    lastPos.current = { x: pos.x, y: pos.y };
  };

  const handlePointerMove = (clientX: number, clientY: number) => {
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
      } else if (dist > 0.05) {
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
  };

  const createPrivate = () => {
    const randomId = Math.random().toString(36).substring(2, 10);
    window.history.pushState({}, '', `?room=${randomId}`);
    setRoomId(randomId);
  };

  const copyShareLink = () => {
    const url = window.location.href;
    navigator.clipboard.writeText(url).then(() => {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    });
  };

  if (!roomId) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-[#0a0a0a] font-sans text-neutral-100 p-6 selection:bg-white/30 relative overflow-hidden">
        
        <div className="z-10 flex flex-col max-w-md w-full">
          <h1 className="text-4xl md:text-5xl font-medium tracking-tighter mb-4 text-white">
            Kaleidosync.
          </h1>
          <p className="text-sm text-neutral-400 mb-10 leading-relaxed max-w-sm">
            Real-time collaborative fractal canvas. Minimal latency, infinite zoom.
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
                <span className="font-semibold text-sm text-neutral-200">Create Private Session</span>
                <span className="text-[11px] text-neutral-500 font-medium">Generate a unique invite link</span>
              </div>
              <Component size={18} className="text-neutral-400 group-hover:scale-110 transition-transform" />
            </button>
          </div>
        </div>
      </div>
    );
  }

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
      
      {/* UI Overlay */}
      <div className="absolute top-6 left-6 bg-[#0a0a0a]/90 backdrop-blur-xl p-5 rounded-2xl border border-neutral-800 shadow-2xl flex flex-col gap-6 max-w-[280px] pointer-events-auto">
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between pointer-events-auto">
            <h1 className="text-xl font-medium tracking-tighter text-white">
              Kaleidosync
            </h1>
            <div className="flex items-center gap-1.5 text-xs font-mono text-neutral-400 bg-neutral-900 px-2 py-1 rounded-md border border-neutral-800">
              <Users size={12} className="text-neutral-500" />
              <span>{connectedUsers}</span>
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
                {['#ffffff', '#a8a29e', '#000000'].map(c => (
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

        <button 
          onClick={emitClear}
          className="flex items-center justify-center gap-2 py-3 px-4 bg-transparent hover:bg-red-500/10 text-red-400 hover:text-red-300 text-[11px] font-bold tracking-wider uppercase transition-colors rounded-lg border border-red-500/20 hover:border-red-500/30"
        >
          <RotateCcw size={14} />
          Clear Canvas
        </button>
      </div>
    </div>
  );
}


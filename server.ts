import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import path from "path";

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: { origin: "*" }
  });
  
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  // In-memory storage for room canvas state
  const roomsState = new Map<string, { strokeOrder: string[], strokes: Record<string, any[]> }>();

  // Expose backend memory state for debug verification
  app.get("/api/debug-state", (req, res) => {
    const stateObj: any = {};
    for (const [key, val] of roomsState.entries()) {
      stateObj[key] = {
        strokeCount: val.strokeOrder.length,
        points: Object.values(val.strokes).reduce((acc, curr) => acc + curr.length, 0)
      };
    }
    res.json({ rooms: stateObj });
  });

  // Real-time synchronization
  io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);

    socket.on("join-room", (roomId) => {
      socket.join(roomId);
      console.log(`Socket ${socket.id} joined room ${roomId}`);
      
      // Send existing canvas state to the newly joined client
      if (roomsState.has(roomId)) {
        console.log(`Sending sync to ${socket.id} for ${roomId}. Strokes: ${roomsState.get(roomId)!.strokeOrder.length}`);
        socket.emit("sync", roomsState.get(roomId));
      } else {
        console.log(`No history available yet for room ${roomId}`);
      }

      const room = io.sockets.adapter.rooms.get(roomId);
      io.to(roomId).emit("user-count", room ? room.size : 0);
    });

    // Synchronize drawing events
    socket.on("draw", (data) => {
      // Save state
      if (!roomsState.has(data.roomId)) {
        roomsState.set(data.roomId, { strokeOrder: [], strokes: {} });
      }
      const roomState = roomsState.get(data.roomId)!;
      if (!roomState.strokes[data.strokeId]) {
        roomState.strokes[data.strokeId] = [];
        roomState.strokeOrder.push(data.strokeId);
      }
      roomState.strokes[data.strokeId].push(data);

      // Broadcast to other clients in the same room
      socket.to(data.roomId).emit("draw", data);
    });

    socket.on("cursor", (data) => {
      socket.to(data.roomId).volatile.emit("cursor", { id: socket.id, ...data });
    });

    socket.on("undo", (data) => {
      // Remove from server state
      const roomState = roomsState.get(data.roomId);
      if (roomState) {
        delete roomState.strokes[data.strokeId];
        roomState.strokeOrder = roomState.strokeOrder.filter(id => id !== data.strokeId);
      }
      socket.to(data.roomId).emit("undo", data);
    });

    socket.on("clear", (roomId) => {
      roomsState.delete(roomId);
      socket.to(roomId).emit("clear");
    });

    socket.on("disconnect", () => {
      console.log("Client disconnected:", socket.id);
      // Update counts for rooms this socket was in
      // Socket.io automatically leaves rooms on disconnect, 
      // but we need to iterate over adapter.rooms if we want accurate counts.
      // Since we only have one main room for this example:
      const roomId = "kaleidoscope-shared";
      const room = io.sockets.adapter.rooms.get(roomId);
      io.to(roomId).emit("user-count", room ? room.size : 0);
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Serve static files in production
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();

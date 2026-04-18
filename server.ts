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

  // Real-time synchronization
  io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);

    // Give new clients the active room ID if requested
    socket.on("join-room", (roomId) => {
      socket.join(roomId);
      console.log(`Socket ${socket.id} joined room ${roomId}`);
      const room = io.sockets.adapter.rooms.get(roomId);
      io.to(roomId).emit("user-count", room ? room.size : 0);
    });

    // Synchronize drawing events
    socket.on("draw", (data) => {
      // Broadcast to other clients in the same room
      socket.to(data.roomId).emit("draw", data);
    });

    socket.on("cursor", (data) => {
      socket.to(data.roomId).volatile.emit("cursor", { id: socket.id, ...data });
    });

    socket.on("undo", (data) => {
      socket.to(data.roomId).emit("undo", data);
    });

    socket.on("clear", (roomId) => {
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

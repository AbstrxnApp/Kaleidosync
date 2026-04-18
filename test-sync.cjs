const { io } = require("socket.io-client");
const socket = io("http://localhost:3000", { path: "/socket.io" });
socket.on("connect", () => {
  socket.emit("join-room", "kaleidoscope-shared");
  socket.emit("draw", {
    roomId: "kaleidoscope-shared",
    strokeId: "test-stroke-1",
    x0: 0, y0: 0, x1: 100, y1: 100,
    color: "#ff0000",
    lineWidth: 4,
    effect: "none"
  });
  
  setTimeout(() => {
    const socket2 = io("http://localhost:3000", { path: "/socket.io" });
    socket2.on("connect", () => {
      socket2.emit("join-room", "kaleidoscope-shared");
    });
    socket2.on("sync", (data) => {
      console.log("Socket 2 received Sync:", data.strokeOrder.length);
      console.log("Data:", JSON.stringify(data));
      process.exit();
    });
  }, 1000);
});

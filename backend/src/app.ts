import express from "express";
import cors from "cors";
import prisma from "./config/database";
import authRoutes from "./auth/auth.routes";
import protectedRoutes from "./auth/auth.protected.route";
import organizationRoutes from "./organization/organization.routes";
import documentRoutes from "./document/document.routes";
import ragRoutes from "./rag/rag.routes";
import agentRoutes, { agentJsonError } from "./agents/agent.routes";
import {
  getDocumentQueue,
  closeDocumentQueue,
} from "./document/document.queue.runtime";

// const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());
app.use(cors());

app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/auth", protectedRoutes);
app.use("/api/v1/organizations", organizationRoutes);
app.use("/api/v1/documents", documentRoutes);
app.use("/api/v1/chat", ragRoutes);
app.use("/api/v1/agents", agentRoutes);
app.use("/api/v1/agents", agentJsonError);

app.get("/api/v1/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;

    res.status(200).json({
      success: true,
      message: "NexaAI backend and database are running",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Database connection failed",
    });
  }
});

const server = app.listen(PORT, () => {
  console.log(`NexaAI backend running on port ${PORT}`);
});

// Warm one producer without preventing login/chat when Redis is unavailable.
// Later document requests can reconnect; extraction runs only in the worker process.
void getDocumentQueue().catch(() =>
  console.error("Document queue is unavailable."),
);
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close(() => {
    void closeDocumentQueue()
      .finally(() => prisma.$disconnect())
      .catch(() => {
        process.exitCode = 1;
      });
  });
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

// // GET endpoint to fetch all users from the database
// app.get('/users', async (req: Request, res: Response) => {
//   try {
//     // prisma.user.findMany() retrieves all records
//     const users = await prisma.user.findMany();
//     res.status(200).json(users);
//   } catch (error) {
//     res.status(500).json({ error: 'Failed to fetch users' });
//   }
// });

// // POST endpoint to add a new user to the database
// app.post('/users', async (req: Request, res: Response): Promise<any> => {
//   const { name, email } = req.body;

//   if (!name || !email) {
//     return res.status(400).json({ error: 'Name and email are required' });
//   }

//   try {
//     // prisma.user.create() inserts a new record
//     const newUser = await prisma.user.create({
//       data: { name, email },
//     });

//     res.status(201).json({
//       message: 'User added successfully',
//       user: newUser
//     });
//   } catch (error: any) {
//     // Prisma error code P2002 means a unique constraint failed (duplicate email)
//     if (error.code === 'P2002') {
//       return res.status(400).json({ error: 'Email already exists' });
//     }
//     res.status(500).json({ error: 'Failed to create user' });
//   }
// });

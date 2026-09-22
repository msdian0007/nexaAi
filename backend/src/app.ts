import express from 'express';
import cors from "cors";
import prisma from './config/database';
import authRoutes from './auth/auth.routes';
import protectedRoutes from './auth/auth.protected.route';
import organizationRoutes from "./organization/organization.routes";
import documentRoutes from "./document/document.routes";

// const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());
app.use(cors());

app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/auth", protectedRoutes)
app.use("/api/v1/organizations", organizationRoutes);
app.use("/api/v1/documents", documentRoutes);

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

app.listen(PORT, () => {
  console.log(`NexaAI backend running on port ${PORT}`);
});




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
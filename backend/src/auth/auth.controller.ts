import { Request, Response } from "express";
import { loginUser, registerInvitedUser, registerUser } from "./auth.service";

export const register = async (req: Request, res: Response) => {
  try {
    const { name, email, password, organizationName } = req.body;

    if (!name || !email || !password || !organizationName) {
      return res.status(400).json({
        success: false,
        message: "Name, email, password and organization name are required",
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 8 characters",
      });
    }

    const result = await registerUser({
      name,
      email,
      password,
      organizationName,
    });

    return res.status(201).json({
      success: true,
      message: "Registration successful",
      data: result,
    });
  } catch (error) {
    console.error("Registration error:", error);

    const message =
      error instanceof Error ? error.message : "Something went wrong";

    return res.status(400).json({
      success: false,
      message,
    });
  }
};

export const login = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    const result = await loginUser({
      email,
      password,
    });

    return res.status(200).json({
      success: true,
      message: "Login successful",
      data: result,
    });
  } catch (error) {
    console.error("Login error:", error);

    const message =
      error instanceof Error ? error.message : "Something went wrong";

    return res.status(401).json({
      success: false,
      message,
    });
  }
};

export const registerInvitation = async (req: Request, res: Response) => {
  try {
    const { name, email, password, token } = req.body ?? {};
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.trim().length > 100 ||
      typeof email !== "string" ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ||
      typeof password !== "string" ||
      password.length < 8 ||
      typeof token !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(token)
    )
      return res
        .status(400)
        .json({
          success: false,
          message:
            "Valid name, invited email, password, and invitation are required",
        });
    return res
      .status(201)
      .json({
        success: true,
        data: await registerInvitedUser({ name, email, password, token }),
      });
  } catch (error) {
    const status =
      error &&
      typeof error === "object" &&
      "status" in error &&
      typeof error.status === "number"
        ? error.status
        : 400;
    return res
      .status(status)
      .json({
        success: false,
        message: "Invitation registration could not be completed",
      });
  }
};

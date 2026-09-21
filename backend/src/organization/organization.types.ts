import { Role } from "@prisma/client";

export interface AddMemberInput {
  email: string;
  role?: Role;
}

export interface UpdateMemberRoleInput {
  role: Role;
}
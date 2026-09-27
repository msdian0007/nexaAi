import { Role } from "../../generated/prisma/enums";

export interface AddMemberInput {
  email: string;
  role?: Role;
}

export interface UpdateMemberRoleInput {
  role: Role;
}

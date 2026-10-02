import { z } from 'zod';

export const Email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email({ message: 'Invalid email address' }));

export const Password = z.string().min(8, 'Password must be at least 8 characters').max(128);

export const LoginBody = z.object({
  email: Email,
  // Do not enforce the policy on login, only a sane bound.
  password: z.string().min(1).max(128),
}).strict();

export const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: Password,
});

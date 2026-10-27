import { z } from "zod";

export const loginSchema = z.object({
  username: z
    .string()
    .trim()
    .min(1, "Введите ваш @username")
    .transform((v) => v.replace(/^@/, "").toLowerCase()),
  password: z.string().min(1, "Введите пароль"),
});

export const registerSchema = z
  .object({
    username: z
      .string()
      .trim()
      .min(2, "Юзернейм должен содержать минимум 2 символа")
      .max(32, "Юзернейм слишком длинный")
      .regex(
        /^@?[a-zA-Z0-9_.-]+$/,
        "Допустимы только латинские буквы, цифры и символы _ . -"
      )
      .transform((v) => v.replace(/^@/, "").toLowerCase()),
    display_name: z
      .string()
      .trim()
      .min(1, "Введите отображаемое имя")
      .max(64, "Имя слишком длинное"),
    password: z
      .string()
      .min(4, "Пароль должен содержать минимум 4 символа")
      .max(128, "Пароль слишком длинный"),
    confirmPassword: z.string().min(1, "Подтвердите пароль"),
    avatar_color: z.string().default("#3B82F6"),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Пароли не совпадают",
    path: ["confirmPassword"],
  });

export const profileSchema = z.object({
  display_name: z
    .string()
    .trim()
    .min(1, "Отображаемое имя не может быть пустым")
    .max(64, "Имя слишком длинное"),
  username: z
    .string()
    .trim()
    .min(2, "Юзернейм должен содержать минимум 2 символа")
    .max(32, "Юзернейм слишком длинный")
    .regex(
      /^@?[a-zA-Z0-9_.-]+$/,
      "Допустимы только латинские буквы, цифры и символы _ . -"
    )
    .transform((v) => v.replace(/^@/, "").toLowerCase()),
  avatar_color: z.string(),
  time_zone: z.string().min(1, "Выберите часовой пояс").optional(),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Введите текущий пароль"),
    newPassword: z
      .string()
      .min(4, "Новый пароль должен содержать минимум 4 символа")
      .max(128, "Пароль слишком длинный"),
    confirmNewPassword: z.string().min(1, "Повторите новый пароль"),
  })
  .refine((data) => data.newPassword === data.confirmNewPassword, {
    message: "Новые пароли не совпадают",
    path: ["confirmNewPassword"],
  });

export function extractZodErrors(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] || "form");
    if (!fieldErrors[key]) {
      fieldErrors[key] = issue.message;
    }
  }
  return fieldErrors;
}

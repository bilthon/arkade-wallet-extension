/**
 * Lightweight password-strength heuristic for the create-password meter. Not a
 * security control (the KDF in `crypto.ts` does the real work) — just UX guidance
 * to nudge users off trivially weak passwords. Score 0–4.
 *
 * ponytail: a deliberately simple heuristic (length + character classes), not a
 * zxcvbn dependency — keeps the bundle lean for the MVP.
 */
export interface PasswordStrength {
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
}

export function passwordStrength(password: string): PasswordStrength {
  if (!password) return { score: 0, label: 'Enter a password' };

  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  if (/\d/.test(password) && /[^A-Za-z0-9]/.test(password)) score++;

  // A short password caps at "weak" regardless of variety.
  if (password.length < 8) score = Math.min(score, 1);

  const clamped = Math.min(4, score) as 0 | 1 | 2 | 3 | 4;
  const labels = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'];
  return { score: clamped, label: labels[clamped] };
}

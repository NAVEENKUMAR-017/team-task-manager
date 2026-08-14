# Team Task Manager

Team Task Manager is an Express, MySQL, and vanilla JavaScript application with JWT authentication, project management, task tracking, and an admin-controlled account lifecycle.

## Authentication model

There is no public registration endpoint or signup screen. An administrator creates every account in the Admin Console. New accounts receive a username and temporary password; at their first sign-in they must choose a new password before they can access projects and tasks. They must then add and verify an email address before it can be used for password reset or optional OTP login.

Email, password-reset, and login OTPs are six digits, expire after five minutes, are bcrypt-hashed in MySQL, and are limited to five verification attempts. OTP requests are additionally limited to three per purpose per 15 minutes per user.

## Prerequisites

- Node.js 20 or later
- MySQL 8 or later
- A Gmail account with a [Google App Password](https://support.google.com/accounts/answer/185833), or compatible SMTP credentials

## Setup

1. Create the MySQL database and tables. For a fresh local database, run:

   ```powershell
   mysql -u root -p < schema.sql
   ```

2. Create your local configuration file:

   ```powershell
   Copy-Item .env.example .env
   ```

3. Edit `.env`. Set your MySQL details, a long random `JWT_SECRET`, Gmail SMTP credentials, and the initial administrator values. `ADMIN_TEMP_PASSWORD` must have at least 8 characters. The server creates this initial administrator only when the `users` table is empty.

   For Gmail, do **not** use your normal Gmail password. Follow the Gmail App Password steps below and use the generated 16-character value as `SMTP_PASS`.

4. Install dependencies:

   ```powershell
   npm.cmd install
   ```

5. Run the application:

   ```powershell
   npm.cmd start
   ```

   For automatic server reloads during development:

   ```powershell
   npm.cmd run dev
   ```

6. Open `http://localhost:3000`, sign in using `ADMIN_USERNAME` and `ADMIN_TEMP_PASSWORD`, choose a permanent password, and verify an email. Use **Admin Console** to create the remaining accounts.

## Gmail OTP setup

The app sends OTPs through Gmail SMTP. This is required for email verification, forgotten-password resets, and optional login with OTP.

1. Sign in to the Gmail account that will send OTPs.
2. Open [Google Account Security](https://myaccount.google.com/security) and enable **2-Step Verification**.
3. Return to the Security page and open **App passwords**. If it is not shown, ensure 2-Step Verification is fully enabled and that the Google account permits App Passwords.
4. Create an App Password for Mail (the name can be `Team Task Manager`).
5. Copy the generated 16-character password. This is the value for `SMTP_PASS`; it is not your normal Gmail password.
6. Add these settings to `.env`, replacing every placeholder:

   ```env
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_SECURE=false
   SMTP_USER=your-gmail-address@gmail.com
   SMTP_PASS=your-16-character-gmail-app-password
   SMTP_FROM=your-gmail-address@gmail.com
   ```

7. Restart the server after saving `.env`:

   ```powershell
   npm.cmd start
   ```

When a user requests an OTP, the server generates a six-digit code, sends it to their email, stores only a bcrypt hash in MySQL, and expires it after five minutes. Never commit `.env`, Gmail passwords, App Passwords, or JWT secrets.

## First administrator checklist

Set these values in `.env` before the first start with an empty database:

```env
JWT_SECRET=generate-a-long-random-secret-here
ADMIN_USERNAME=admin
ADMIN_NAME=Initial Administrator
ADMIN_TEMP_PASSWORD=choose-an-8-character-minimum-temporary-password
```

After starting the server, sign in with the administrator username and temporary password. You will be required to choose a new password and verify an email before the Admin Console is available. From the Admin Console, create accounts for all other users.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Optional complete MySQL URL; overrides individual `DB_*` variables. |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | Local MySQL connection settings. |
| `JWT_SECRET` | Required secret for signing JWTs. Never commit it. |
| `ADMIN_USERNAME`, `ADMIN_NAME`, `ADMIN_TEMP_PASSWORD` | One-time bootstrap administrator values for an empty database. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | SMTP server connection (Gmail: `smtp.gmail.com`, `587`, `false`). |
| `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Gmail address, Gmail App Password, and sender address. |
| `PORT` | HTTP port, default `3000`. |

`.env` is intentionally ignored by Git. Do not put passwords, SMTP App Passwords, or JWT secrets in code or source control.

## Admin Console

Admins can create users with username, name, temporary password, and role. They can view users, activate/deactivate them, reset a temporary password, and switch admin/member roles. The console and all `/api/admin/*` endpoints require an active admin JWT.

## API overview

- `POST /api/auth/login` — username and password login
- `POST /api/auth/change-temporary-password` — authenticated first-login password change
- `POST /api/auth/email/request`, `POST /api/auth/email/verify` — verified email setup
- `POST /api/auth/forgot-password/request`, `POST /api/auth/forgot-password/verify` — email OTP password reset
- `POST /api/auth/login-otp/request`, `POST /api/auth/login-otp/verify` — optional email OTP login
- `GET /api/admin/users`, `POST /api/admin/users`, `PATCH /api/admin/users/:id`, `POST /api/admin/users/:id/reset-password` — admin account controls
- `GET/POST /api/projects`, `GET/POST/PATCH/DELETE /api/tasks`, and `GET /api/dashboard` — existing project and task functionality

## Existing database migration

The server creates missing authentication columns/tables on startup and preserves existing project/task tables. Existing users are assigned a fallback username (`user_<id>`) if they did not already have one; an administrator should update/re-provision those accounts as appropriate. For a clean installation, run `schema.sql` before starting the server.

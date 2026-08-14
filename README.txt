# Team Task Manager — MySQL Edition

Full-stack Team Task Manager for the assessment: authentication, Admin/Member roles, project/team management, task assignment/status tracking, dashboard metrics, REST APIs and MySQL.

## Stack
- Node.js 20+ + Express
- MySQL 8 / Railway MySQL
- mysql2
- JWT authentication + bcrypt password hashing
- Vanilla HTML/CSS/JavaScript frontend

## Features
- Signup and login
- First registered account becomes Admin; later accounts are Members
- Project creation
- Team/member assignment
- Task creation and assignment
- Todo / In Progress / Done status
- Low / Medium / High priority
- Due dates and overdue dashboard count
- Admin-only task deletion and team-member assignment
- REST API
- Responsive frontend

## Local setup
1. Install Node.js 20+ and MySQL 8+.
2. Create a database named `taskmanager` or run `schema.sql`.
3. Copy `.env.example` to `.env`.
4. Set `DATABASE_URL`, for example:
   `mysql://root:password@localhost:3306/taskmanager`
5. Set a strong `JWT_SECRET`.
6. Run `npm install`.
7. Run `npm start`.
8. Open `http://localhost:3000`.

The server also creates the required tables automatically on startup.

## Railway deployment with MySQL
1. Push this project to GitHub.
2. Create a Railway project and deploy the GitHub repository.
3. Add a MySQL database/service to the Railway project (use Railway's MySQL offering if available for your account; otherwise use a managed MySQL provider and connect its URL).
4. Add `DATABASE_URL` to the application service using the MySQL service connection URL.
5. Add `JWT_SECRET` with a long random value.
6. Railway runs `npm start` automatically.
7. Generate a public domain under the service Networking settings.
8. Open the domain and register the first account as Admin.

## API
- POST `/api/auth/signup`
- POST `/api/auth/login`
- GET `/api/me`
- GET `/api/users`
- GET/POST `/api/projects`
- POST `/api/projects/:id/members` (Admin)
- GET/POST `/api/tasks`
- PATCH/DELETE `/api/tasks/:id`
- GET `/api/dashboard`

## Submission checklist
- Live Railway URL
- GitHub repository
- README
- 2–5 minute demo video

## Demo flow
1. Register the first account and show Admin role.
2. Create a project.
3. Register a second account as Member.
4. Assign the Member to the project.
5. Create and assign tasks.
6. Change task statuses.
7. Show dashboard totals and overdue tasks.
8. Log in as Member and demonstrate role restrictions.

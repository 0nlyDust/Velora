# Velora

Modern personal finance dashboard focused on budgeting, spending analytics and editable transaction categories.

## Live Demo

[https://tu-url-vercel.vercel.app](https://velora-pink-delta.vercel.app/)

Create any account and load demo data directly inside the app.

---

## Features

* Monthly budgeting
* Editable spending categories
* Transaction calendar
* Spending analytics
* Demo mode with seeded data
* PostgreSQL persistence
* Responsive minimal UI

---

## Stack

* React + Vite
* Node.js + Express
* PostgreSQL
* Render
* Vercel

---

## Local Development

### Backend

```bash
cd server
npm install
npm run dev
```

### Frontend

```bash
cd client
npm install
npm run dev
```

Frontend runs on:

```txt
http://localhost:5173
```

Backend runs on:

```txt
http://localhost:3001
```

---

## Environment Variables

Example PostgreSQL connection:

```env
DATABASE_URL=postgresql://postgres:TUPASSWORD@localhost:5432/velora
```

Create `.env` files inside:

* `/server`
* `/client`

---

## Screenshots

*Add screenshots here*

---

## Notes

Bank integrations were prototyped using the TrueLayer sandbox environment.

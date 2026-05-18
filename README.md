# Velora

App web de finanzas personales con PostgreSQL, login Google/GitHub/email, TrueLayer y calendario mensual.

## Ejecutar en local

### 1. Configura npm para evitar registry raro

```bash
npm config set registry https://registry.npmjs.org/
npm config delete proxy
npm config delete https-proxy
npm cache clean --force
```

### 2. Backend

```bash
cd server
npm install
cp .env.example .env
npm run dev
```

En Windows, crea `server/.env` manualmente copiando `.env.example`.

### 3. Frontend

En otra terminal:

```bash
cd client
npm install
cp .env.example .env
npm run dev
```

Abre:

```txt
http://localhost:5173
```

## URLs locales importantes

Backend:

```txt
http://localhost:3001
```

Frontend:

```txt
http://localhost:5173
```

Google redirect URI local:

```txt
http://localhost:3001/api/auth/google/callback
```

GitHub redirect URI local:

```txt
http://localhost:3001/api/auth/github/callback
```

TrueLayer redirect URI local:

```txt
http://localhost:3001/api/truelayer/callback
```

## PostgreSQL

Crea una base de datos llamada `velora` y configura:

```env
DATABASE_URL=postgresql://postgres:TUPASSWORD@localhost:5432/velora
```

Las tablas se crean automáticamente al arrancar el server.

## Producción

Lee `PRODUCCION.md` antes de conectar bancos reales.

## Cambios de esta versión

- Interfaz más minimalista: fondo limpio, cards blancas y menos degradados.
- Calendario mensual con días clicables.
- Panel lateral de movimientos diarios para ver ingresos/gastos de cada día.
- Selector de categoría más grande y claro.
- Aviso de revisión de categoría más visible.

# Velora — checklist para producción

## 1) Antes de conectar un banco real
No conectes cuentas reales hasta que tengas:

- Dominio propio con HTTPS.
- PostgreSQL en producción, por ejemplo Neon, Railway o Render.
- `NODE_ENV=production`.
- `SESSION_SECRET` largo y privado.
- OAuth Google/GitHub configurado con URLs de producción.
- TrueLayer verificado en modo producción.

En producción la app bloquea la conexión bancaria real salvo que añadas:

```env
PRODUCTION_BANKING_CONFIRMED=true
TRUELAYER_ENV=production
```

Esto evita que conectes un banco real por accidente.

## 2) URLs de producción
Ejemplo si tu dominio es `https://velora.app` y la API es `https://api.velora.app`:

```env
CLIENT_URL=https://velora.app
GOOGLE_REDIRECT_URI=https://api.velora.app/api/auth/google/callback
GITHUB_REDIRECT_URI=https://api.velora.app/api/auth/github/callback
TRUELAYER_REDIRECT_URI=https://api.velora.app/api/truelayer/callback
DATABASE_SSL=true
```

En Google Cloud, GitHub y TrueLayer tienes que pegar exactamente esas mismas redirect URIs.

## 3) Deploy recomendado

- Frontend: Vercel o Netlify.
- Backend: Render, Railway o Fly.io.
- PostgreSQL: Neon o Railway PostgreSQL.

## 4) Variables del frontend
En producción, el cliente necesita:

```env
VITE_API_URL=https://api.velora.app
```

## 5) Cambios incluidos en esta versión

- Motor de categorías ampliado: DVLA, EDF Energy, Working Tax Credit, Butlins Holidays, OUTGOING DD, impuestos, facturas, viajes, coche, gobierno.
- Deduplicación defensiva al importar desde TrueLayer.
- Botón “Quitar duplicados”.
- Calendario mensual con ingresos, gastos y movimientos por día.
- Bloqueo de banco real hasta confirmar producción.
- Rutas alias `/auth/google/callback`, `/auth/github/callback` y `/truelayer/callback` para evitar errores si configuras URLs sin `/api`.

## 6) Importante sobre categorías
La clasificación es por reglas + aprendizaje del historial. No usa IA ni envía datos financieros a terceros. Cuando corrijas categorías manualmente o añadas categorías, el sistema puede reutilizar patrones similares.

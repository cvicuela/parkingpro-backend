# Recuperación de acceso — ParkingPro

> Las contraseñas se guardan **hasheadas con bcrypt** (`pgcrypto`: `crypt(pwd, gen_salt('bf',10))`).
> El texto plano **no existe** en ninguna parte: no se puede leer, solo *resetear*.
> El login en vivo usa la RPC de Supabase `authenticate(p_email, p_password, p_ip)`.

## Pasos (desde tu panel de Supabase → SQL Editor)

### 1. Ver qué cuentas existen
```sql
SELECT email, role, status, verified FROM users ORDER BY role;
```

### 2. Asignar una contraseña nueva al admin
Usa el mismo método que la RPC interna `set_user_password` (migración 008):
```sql
UPDATE users
SET password_hash = extensions.crypt('TU_NUEVA_CLAVE', extensions.gen_salt('bf', 10)),
    updated_at = NOW()
WHERE email = 'admin@parkingpro.com';   -- reemplaza por el email real del paso 1
```

### 3. (Opcional) Crear un admin nuevo si no existe ninguno
```sql
INSERT INTO users (email, phone, password_hash, role, verified, verified_at, status)
VALUES (
  'tu-email@dominio.com',
  '+18090000000',
  extensions.crypt('TU_NUEVA_CLAVE', extensions.gen_salt('bf', 10)),
  'super_admin', true, NOW(), 'active'
);
```

### 4. Iniciar sesión
En `https://parkingpro.netlify.app/login` con el email y `TU_NUEVA_CLAVE`.

---
**Nota histórica:** el backdoor `admin123` y las cuentas demo fueron deshabilitados en mayo 2026.
Los hashes en `database/seed.sql` son placeholders (`$2a$10$YourHashedPasswordHere`) y no autentican.

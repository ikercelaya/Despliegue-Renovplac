# Renovebot

Chatbot de Renoveplac (reformas integrales en Lliria, Valencia) con:

- Chat embebible en `renoveplac.com` (widget flotante).
- Recogida del formulario de la web → conversación iniciada por el bot + email al cliente.
- Persistencia de conversaciones en **Supabase**.
- **Panel admin** (`/admin`) para ver, responder y pausar el bot por conversación.
- Presupuestos orientativos con botón de **aceptar** que envía un email a `contacto@renoveplac.com`.
- Base de conocimiento del bot en `info/` (datos de la empresa, FAQs).

## Estructura

```
.
├── server.js              Express con todos los endpoints
├── lib/
│   ├── claude.js          Llamada a Anthropic + tool create_budget
│   ├── db.js              Cliente Supabase
│   ├── email.js           Nodemailer SMTP
│   └── prompt.js          System prompt construido con info/
├── public/
│   ├── index.html         Chat del cliente (con token o widget)
│   ├── admin.html         Panel de Renoveplac
│   └── widget.js          Script para incrustar el chat en WordPress
├── info/                  Base de conocimiento (txt). Editable.
├── sql/schema.sql         Esquema de Supabase
├── vercel.json            Config para Vercel (incluye info/)
├── Dockerfile
├── .env.example
└── package.json
```

## Requisitos

- Node.js 20+ (o Docker).
- Cuenta de Anthropic (API key).
- Proyecto Supabase.
- SMTP para `contacto@renoveplac.com`.

## 1. Configurar Supabase

1. Crea proyecto en [supabase.com](https://supabase.com).
2. Abre el **SQL Editor** y ejecuta el contenido de [`sql/schema.sql`](sql/schema.sql).
3. Copia las credenciales:
   - `Project URL` → `SUPABASE_URL`
   - `service_role` key (Settings → API) → `SUPABASE_SERVICE_KEY`. **No** uses la `anon` key, el bot necesita escribir en las tablas.

## 2. Variables de entorno

```bash
cp .env.example .env
```

Rellena `.env`:

```env
ANTHROPIC_API_KEY=sk-ant-api03-...
ANTHROPIC_MODEL=claude-sonnet-4-5-20250929
PORT=3000
PUBLIC_URL=https://pruebas-chat-bot-renove-plac.vercel.app

SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...

SMTP_HOST=smtp.tu_proveedor.com
SMTP_PORT=587
SMTP_USER=contacto@renoveplac.com
SMTP_PASS=tu_password
SMTP_FROM=Renoveplac <contacto@renoveplac.com>

ADMIN_PASSWORD=cambia_esta_contrasena
FORM_SECRET=un_valor_aleatorio_largo
```

`PUBLIC_URL` es la URL pública del bot (la usa para los enlaces del email).

## 3. Ejecutar local

```bash
npm install
npm start
```

- Chat: http://localhost:3000
- Admin: http://localhost:3000/admin (entrar con `ADMIN_PASSWORD`)

## 4. Desplegar en Vercel

El repo ya incluye `vercel.json` con `includeFiles` para que `info/` y `public/` viajen al bundle.

1. Conecta el repo en Vercel.
2. En **Settings → Environment Variables** añade todas las del `.env`.
3. Deploy.

## 5. Conectar el formulario de WordPress

El formulario de `renoveplac.com` debe enviar los campos a `POST {PUBLIC_URL}/api/form` con el header `X-Form-Secret: <FORM_SECRET>`.

Campos esperados (acepta nombres en inglés o castellano):

| Campo | Alternativa |
| --- | --- |
| `name` | `nombre` |
| `email` | `correo` |
| `phone` | `telefono` |
| `postal_code` | `cp` |
| `work_type` | `tipo_trabajo` |
| `message` | `mensaje` |

### Opción A — Plugin de formularios con webhooks (WPForms, Fluent Forms, Forminator…)

Configura un webhook con:
- URL: `https://TU_DOMINIO/api/form`
- Método: `POST`
- Headers: `X-Form-Secret: TU_FORM_SECRET`, `Content-Type: application/json`
- Body: mapea los campos del formulario a las claves de la tabla.

### Opción B — Snippet en `functions.php`

```php
add_action( 'wpcf7_mail_sent', 'renovebot_forward_lead' ); // Contact Form 7
function renovebot_forward_lead( $contact_form ) {
    $submission = WPCF7_Submission::get_instance();
    if ( ! $submission ) return;
    $data = $submission->get_posted_data();
    wp_remote_post( 'https://TU_DOMINIO/api/form', [
        'headers' => [
            'Content-Type' => 'application/json',
            'X-Form-Secret' => 'TU_FORM_SECRET',
        ],
        'body' => wp_json_encode( [
            'name'         => $data['nombre']         ?? '',
            'email'        => $data['correo']         ?? '',
            'phone'        => $data['telefono']       ?? '',
            'postal_code'  => $data['cp']             ?? '',
            'work_type'    => $data['tipo_trabajo']   ?? '',
            'message'      => $data['mensaje']        ?? '',
        ] ),
        'timeout' => 10,
    ] );
}
```

### Probar el endpoint con curl

```bash
curl -X POST https://TU_DOMINIO/api/form \
  -H "Content-Type: application/json" \
  -H "X-Form-Secret: TU_FORM_SECRET" \
  -d '{"name":"Pepe","email":"pepe@example.com","phone":"600000000","postal_code":"46160","work_type":"Reforma de Bano","message":"Quiero reformar el bano"}'
```

Resultado esperado: `{"ok":true,"conversationId":"...","chatUrl":"..."}` y dos emails (uno al cliente con el link al chat y otro a `contacto@renoveplac.com` con el lead).

## 6. Incrustar el widget en WordPress

Pega esta línea en el `<head>` (o usa un plugin tipo **Insert Headers and Footers**):

```html
<script async src="https://TU_DOMINIO/widget.js" data-base-url="https://TU_DOMINIO"></script>
```

Aparecerá un botón circular abajo a la derecha. Al pulsar abre el chat en un iframe. La conversación se guarda en `localStorage` para que el visitante recupere el hilo si vuelve.

## 7. Editar la base de conocimiento

Todo lo que sabe el bot sobre la empresa vive en `info/`:

- `info/Datos de la empresa.txt`
- `info/Preguntas frecuentes y casos especiales.txt`

Edita estos archivos y redeploya. El bot los carga al arrancar y los inyecta en el system prompt.

## 8. Flujo de presupuestos

1. El bot cualifica al cliente.
2. Cuando hay alcance + zona + intención, llama a la tool `create_budget` y se inserta en la BD (`status = pending`).
3. El chat muestra una tarjeta con título, importe y botón **Aceptar presupuesto**.
4. Al aceptar:
   - El presupuesto pasa a `status = accepted`.
   - Se actualiza la conversación a `budget_accepted`.
   - Se envía un email a `contacto@renoveplac.com` con todos los datos del cliente y el presupuesto, con `Reply-To` apuntando al cliente.
   - El bot añade un mensaje confirmando.

## 9. Panel de admin

`/{PUBLIC_URL}/admin`

- Lista de conversaciones (más recientes arriba).
- Por conversación: ver historial, presupuestos, datos del cliente.
- **Pausar bot** → toma el control y responde tú directamente desde el panel. El cliente lo ve igual en su chat (los mensajes del admin aparecen como burbujas amarillas).
- **Cerrar conversación** → bloquea nuevos mensajes del cliente.

## 10. Endpoints

| Endpoint | Método | Notas |
| --- | --- | --- |
| `/` | GET | Chat del cliente |
| `/admin` | GET | Panel |
| `/widget.js` | GET | Script del widget |
| `/api/form` | POST | Webhook del formulario WP |
| `/api/chat` | POST | `{ message, conversationId?, token? }` |
| `/api/conversation` | GET | `?token=` o `?id=` |
| `/api/messages` | GET | Polling con `?since=ISO_DATE` |
| `/api/budget/:id/accept` | POST | Aceptar presupuesto |
| `/api/admin/login` | POST | `{ password }` |
| `/api/admin/conversations` | GET | Lista |
| `/api/admin/conversations/:id` | GET | Detalle |
| `/api/admin/conversations/:id/reply` | POST | Mensaje desde admin |
| `/api/admin/conversations/:id/toggle-bot` | POST | `{ enabled: bool }` |
| `/api/admin/conversations/:id/close` | POST | Cerrar |

## Seguridad

- No subas `.env` al repo. La `service_role` de Supabase tiene permisos totales sobre la BD.
- `ADMIN_PASSWORD` viaja en el header `Authorization: Bearer ...` — usa siempre HTTPS (Vercel ya da HTTPS por defecto).
- `FORM_SECRET` evita que cualquiera spamee el endpoint `/api/form`.

## Datos de Renoveplac (referencia)

- Persona responsable: **Luis Eduardo Romero Martinelli**
- Email: **contacto@renoveplac.com**
- Teléfono / WhatsApp: **631188813**
- Web: **renoveplac.com**

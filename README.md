# Renovebot

Chatbot de Renoveplac (reformas integrales en Lliria, Valencia) con:

- Chat embebible en `renoveplac.com` (widget flotante).
- **Canal WhatsApp** vía Cloud API de Meta (mismo bot, mismo histórico, en el número de la empresa).
- Recogida del formulario de la web → conversación iniciada por el bot + email al cliente.
- Persistencia de conversaciones en **Supabase** (incluye subida de imágenes del chat a Storage).
- **Panel admin** (`/admin`) para ver, responder y pausar el bot por conversación.
- Presupuestos orientativos con botón de **aceptar** en web y respuesta `ACEPTO` por WhatsApp; en ambos casos envía un email a `contacto@renoveplac.com`.
- Base de conocimiento del bot en `info/` (datos de la empresa, FAQs).

## Estructura

```
.
├── server.js              Express con todos los endpoints (chat web, admin, formulario WP, WhatsApp)
├── lib/
│   ├── claude.js          Llamada a Anthropic + tools create_budget y notify_human
│   ├── db.js              Cliente Supabase
│   ├── email.js           Envio por Resend API + respaldo SMTP
│   ├── prompt.js          System prompt construido con info/
│   └── whatsapp.js        Cloud API de Meta (envío, descarga de media, firma de webhooks)
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
3. Para activar la confirmación de presupuestos por email, ejecuta también [`sql/email-confirmation.sql`](sql/email-confirmation.sql).
4. Copia las credenciales:
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
ANTHROPIC_MAX_TOKENS=650
PORT=3000
PUBLIC_URL=https://pruebas-chat-bot-renove-plac.vercel.app

SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...

# Email con Resend (recomendado). RESEND_FROM debe usar un dominio verificado.
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxxx
RESEND_FROM=Renoveplac <presupuestos@tu-dominio-verificado.com>

# SMTP opcional como respaldo si no defines RESEND_API_KEY.
SMTP_HOST=smtp.tu_proveedor.com
SMTP_PORT=587
SMTP_USER=contacto@renoveplac.com
SMTP_PASS=tu_password
SMTP_FROM=Renoveplac <contacto@renoveplac.com>

ADMIN_PASSWORD=cambia_esta_contrasena
FORM_SECRET=un_valor_aleatorio_largo

# WhatsApp Cloud API (Meta) — ver sección "Conectar WhatsApp" más abajo
WHATSAPP_VERIFY_TOKEN=cadena_aleatoria_que_inventes
WHATSAPP_APP_SECRET=clave_secreta_de_la_app
WHATSAPP_TOKEN=EAAxxxxxxxxxxx_token_permanente_del_usuario_de_sistema
WHATSAPP_PHONE_NUMBER_ID=identificador_del_numero_de_telefono
WHATSAPP_BUSINESS_ACCOUNT_ID=identificador_de_la_cuenta_de_whatsapp_business
WHATSAPP_API_VERSION=v21.0
WHATSAPP_HISTORY_LIMIT=24
```

`PUBLIC_URL` es la URL pública del bot (la usa para los enlaces del email y debe coincidir con el dominio que configures como Callback URL del webhook de WhatsApp).

Para Vercel con Resend basta con definir `RESEND_API_KEY` y `RESEND_FROM`.
`RESEND_FROM` debe ser una direccion del dominio verificado en Resend, por ejemplo
`Renoveplac <presupuestos@renoveplac.com>`. Si no existe `RESEND_API_KEY`,
el sistema intenta enviar con la configuracion SMTP.

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
| `/api/chat` | POST | `{ message, conversationId?, token?, image_url? }` |
| `/api/upload` | POST | Subida de imagen del chat a Supabase Storage (`{ data, mimeType, conversationId?, token? }`) |
| `/api/conversation` | GET | `?token=` o `?id=` |
| `/api/messages` | GET | Polling con `?since=ISO_DATE` |
| `/api/budget/:id/confirm` | GET | Confirmar email antes de mostrar presupuesto |
| `/api/budget/:id/accept` | POST | Aceptar presupuesto |
| `/api/admin/login` | POST | `{ password }` |
| `/api/admin/conversations` | GET | Lista |
| `/api/admin/conversations/:id` | GET | Detalle |
| `/api/admin/conversations/:id/reply` | POST | Mensaje desde admin |
| `/api/admin/conversations/:id/toggle-bot` | POST | `{ enabled: bool }` |
| `/api/admin/conversations/:id/close` | POST | Cerrar |
| `/api/admin/conversations/:id/delete` | POST | Eliminar conversación |
| `/api/whatsapp/webhook` | GET | Verificación del webhook (handshake con `hub.verify_token`) |
| `/api/whatsapp/webhook` | POST | Recepción de mensajes entrantes de WhatsApp |

## 11. Conectar WhatsApp (Cloud API de Meta)

El bot recibe y responde mensajes en el número de la empresa usando la **Cloud API** de Meta. Cuando un cliente escribe al WhatsApp, el webhook `POST /api/whatsapp/webhook` recibe el mensaje, lo guarda en la misma tabla `bot_conversations` (con `channel = 'whatsapp'`), llama al modelo y responde por WhatsApp. Si el bot genera un presupuesto, lo manda como una tarjeta de texto pidiendo que el cliente responda `ACEPTO` para confirmarlo.

### Requisitos previos en Meta

1. **Portafolio empresarial** verificado en Business Manager (`business.facebook.com`).
2. **Cuenta de WhatsApp Business (WABA)** creada y aprobada dentro de ese portafolio.
3. **Aplicación de Meta** (tipo Empresa) con el producto **WhatsApp** añadido y en modo Producción.
4. **Número de teléfono** registrado en el WABA, con PIN de verificación en dos pasos configurado (estado: "Registrado").
5. **Usuario de sistema** con control total sobre el WABA, usado para generar un token permanente.

### Variables que hay que definir

| Variable | Dónde se saca |
| --- | --- |
| `WHATSAPP_VERIFY_TOKEN` | Cadena aleatoria que inventas. Debe coincidir con la que pones en el panel del webhook de Meta. |
| `WHATSAPP_APP_SECRET` | App Dashboard → **Configuración de la aplicación** → **Básica** → **Clave secreta de la app** → *Mostrar*. |
| `WHATSAPP_TOKEN` | Business Manager → **Usuarios del sistema** → usuario API → **Generar token** con permisos `whatsapp_business_messaging` y `whatsapp_business_management`. **Caducidad: Nunca**. |
| `WHATSAPP_PHONE_NUMBER_ID` | App Dashboard → **WhatsApp → Configuración de la API**: campo *Identificador del número de teléfono* del número de producción. |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | Mismo panel, campo *WhatsApp Business Account ID*. No lo usa el código en runtime, pero es útil para gestionar plantillas y suscripciones por API. |
| `WHATSAPP_API_VERSION` | Opcional. Por defecto `v21.0`. |

### Configurar el webhook en Meta

1. Sube todas las variables anteriores a Vercel (Settings → Environment Variables) y haz **Redeploy**.
2. App Dashboard → **WhatsApp → Configuración** (o **Webhooks**) → **Editar**:
   - **URL de devolución de llamada**: `https://TU_DOMINIO/api/whatsapp/webhook`
   - **Token de verificación**: el mismo valor que pusiste en `WHATSAPP_VERIFY_TOKEN`.
3. Pulsa **Verificar y guardar**. Meta llamará a tu endpoint con un GET; si Vercel responde 200 + el `hub.challenge`, queda guardado. Si falla, revisa que el redeploy esté hecho y que el verify token coincida exactamente.
4. En la sección **Campos del webhook**, suscríbete a **`messages`** (es el único que el código usa por ahora).
5. Vuelve a **WhatsApp → Configuración de la API** y activa el toggle **Subscribe webhooks** del número de producción.

### Probar la integración

- Envía un WhatsApp desde tu móvil al número de Renoveplac.
- En los logs de Vercel debería aparecer `[whatsapp] webhook verificado` (la primera vez) y, después, los mensajes entrantes.
- El bot responde por WhatsApp aplicando las mismas reglas que en la web: cualifica el lead, pide datos y termina con un presupuesto orientativo.
- Si el bot genera un presupuesto y el cliente responde `ACEPTO` (o variaciones: "si acepto", "aceptar"...), se marca como aceptado y se manda el email a `contacto@renoveplac.com`.

### Notas

- **Ventana de 24 horas**: dentro de las 24 h posteriores al último mensaje del cliente, el bot puede contestar libremente. Pasado ese plazo solo puedes enviar **plantillas pre-aprobadas** (el código no lo hace por ahora; si lo necesitas, hay `wa.sendTemplate` ya implementado en `lib/whatsapp.js`).
- **Velocidad de respuesta**: `ANTHROPIC_MAX_TOKENS` limita la longitud máxima de la respuesta del modelo y `WHATSAPP_HISTORY_LIMIT` limita cuántos mensajes recientes de WhatsApp se mandan como contexto. Valores más bajos suelen responder antes; un rango razonable es `500-650` tokens y `16-24` mensajes.
- **Método de pago**: para mensajes de pago (templates fuera de la ventana de 24 h) Meta exige método de pago en el WABA. Para conversaciones iniciadas por el cliente y respondidas dentro de la ventana, el tier gratuito de Meta cubre las primeras 1000 conversaciones/mes.
- Si quieres que el panel `/admin` también funcione para conversaciones de WhatsApp: ya lo hace, `bot_enabled` y respuestas del admin se aplican igual, pero las respuestas del admin desde el panel **no** se reenvían automáticamente a WhatsApp (quedan solo en la BD). Si en algún momento quieres reenviarlas también por WhatsApp, hay que añadirlo en `POST /api/admin/conversations/:id/reply`.

## Seguridad

- No subas `.env` al repo. La `service_role` de Supabase tiene permisos totales sobre la BD.
- `ADMIN_PASSWORD` viaja en el header `Authorization: Bearer ...` — usa siempre HTTPS (Vercel ya da HTTPS por defecto).
- `FORM_SECRET` evita que cualquiera spamee el endpoint `/api/form`.
- `WHATSAPP_APP_SECRET` se usa para validar la firma HMAC-SHA256 de cada webhook entrante (`X-Hub-Signature-256`). Si no se define, el código acepta los webhooks sin firmar — en producción **debe** estar siempre definida.
- `WHATSAPP_TOKEN` y `WHATSAPP_APP_SECRET` son los secretos más sensibles del bot: con ellos cualquiera puede enviar mensajes desde el número de la empresa.

## Datos de Renoveplac (referencia)

- Persona responsable: **Luis Eduardo Romero Martinelli**
- Email: **contacto@renoveplac.com**
- Teléfono / WhatsApp: **631188813**
- Web: **renoveplac.com**

## Autor

Proyecto diseñado, desarrollado e integrado por **Iker Celaya Buezo** ([LinkedIn](https://www.linkedin.com/in/iker-celaya-buezo-819b1b251)) en nombre de **Propulsa** ([ia-propulsa.com](https://ia-propulsa.com)).

> Propulsa — Soluciones de IA y automatización para negocios.

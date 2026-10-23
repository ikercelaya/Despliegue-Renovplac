const Anthropic = require("@anthropic-ai/sdk");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";
const MAX_TOKENS = Math.max(128, Number(process.env.ANTHROPIC_MAX_TOKENS) || 650);

// No hay herramienta de presupuestos: el bot nunca da importes. Recoge los datos
// con register_request y el equipo prepara el presupuesto detallado.
const TOOLS = [
  {
    name: "notify_human",
    description:
      "Envía un aviso por email a Renoveplac para que un profesional del equipo tome el caso. No tiene efecto visible en el chat para el cliente. Úsala cuando: el cliente tiene una queja/reclamación, pide hablar con una persona, o es un lead premium (administrador de fincas, presidente de comunidad, arquitecto, aparejador).",
    input_schema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          enum: ["queja", "solicita_humano", "lead_premium"],
          description: "Motivo del aviso.",
        },
        summary: {
          type: "string",
          description:
            "Resumen breve para el equipo: qué necesita, zona, datos de contacto si los hay y cualquier detalle relevante. Lo verán por email.",
        },
      },
      required: ["reason", "summary"],
    },
  },
  {
    name: "register_request",
    description:
      "Registra la solicitud del cliente (cualquier servicio: reformas y obra o electricidad) y avisa al equipo por email para que prepare el presupuesto. Usala solo cuando el cliente ya te haya dado en la conversacion: que necesita, pueblo (dentro de zona), direccion de la obra, nombre, telefono, confirmacion de que es propietario o tiene permiso del propietario, y como nos ha conocido. Las fotos o el video no son obligatorios. No inventes ningun dato: si falta alguno, pidelo antes.",
    input_schema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["reformas_obra", "electricidad"],
          description: "electricidad para boletin/CIE, instalacion electrica, cuadro y potencia, punto de recarga, placas solares o averias electricas; reformas_obra para todo lo demas.",
        },
        service: {
          type: "string",
          description: "Servicio en pocas palabras. Ej: 'Reforma de baño', 'Reparación de tejado', 'Boletín eléctrico', 'Placas solares'.",
        },
        need: { type: "string", description: "Que necesita el cliente, en sus palabras y con los detalles que haya dado." },
        town: { type: "string", description: "Pueblo de la obra (solo para comprobar la zona)." },
        address: { type: "string", description: "Direccion de la obra tal como la ha dado el cliente." },
        location: {
          type: "string",
          description: "Enlace de Google Maps o ubicacion de WhatsApp si la ha enviado. Vacio si no.",
        },
        customer_name: { type: "string", description: "Nombre del cliente tal como lo ha dado." },
        phone: { type: "string", description: "Telefono del cliente (9 cifras o con +34)." },
        media_sent: { type: "boolean", description: "true si ha enviado fotos o video." },
        owner_confirmed: {
          type: "boolean",
          description: "true solo si el cliente ha confirmado que es el propietario o que tiene permiso del propietario.",
        },
        lead_source: {
          type: "string",
          description: "Como nos ha conocido el cliente (Google, Instagram, recomendacion...).",
        },
      },
      required: ["category", "service", "need", "town", "address", "customer_name", "phone", "owner_confirmed", "lead_source"],
    },
  },
];

async function runConversation({ systemPrompt, messages, onNotifyHuman, onRequest, maxTokens }) {
  const working = messages.map((m) => ({ role: m.role, content: m.content }));
  let finalText = "";
  let request = null;
  let safety = 0;
  const outputTokens = Math.max(128, Number(maxTokens) || MAX_TOKENS);

  while (safety < 3) {
    safety += 1;
    const startedAt = Date.now();
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: outputTokens,
      system: systemPrompt,
      tools: TOOLS,
      messages: working,
    });
    console.log(`[anthropic] respuesta en ${Date.now() - startedAt}ms (${MODEL})`);

    const textBlocks = [];
    const toolUses = [];
    for (const block of response.content) {
      if (block.type === "text" && block.text) textBlocks.push(block.text);
      if (block.type === "tool_use") toolUses.push(block);
    }

    if (textBlocks.length) finalText = textBlocks.join("\n").trim();

    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      break;
    }

    working.push({ role: "assistant", content: response.content });

    const toolResults = [];
    for (const tu of toolUses) {
      if (tu.name === "notify_human" && typeof onNotifyHuman === "function") {
        try {
          await onNotifyHuman(tu.input);
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content:
              "Aviso enviado al equipo de Renoveplac por email. El cliente NO ha sido notificado por la tool: díselo tú con naturalidad en tu siguiente mensaje.",
          });
        } catch (err) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: `Error enviando aviso al equipo: ${err.message}`,
            is_error: true,
          });
        }
      } else if (tu.name === "register_request" && typeof onRequest === "function") {
        try {
          request = await onRequest(tu.input);
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content:
              "Solicitud registrada y equipo avisado por email. Cierra con: \"Perfecto, ya tengo todo lo necesario. Un profesional de nuestro equipo revisa tu caso y te contactamos para preparar el presupuesto, sin compromiso.\"",
          });
        } catch (err) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: `No se ha registrado la solicitud: ${err.message}`,
            is_error: true,
          });
        }
      } else {
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: "Tool desconocida.",
          is_error: true,
        });
      }
    }

    working.push({ role: "user", content: toolResults });
  }

  return { text: finalText, request };
}

module.exports = { runConversation };

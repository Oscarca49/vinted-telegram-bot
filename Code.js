const CONFIG = {
  INBOX_FOLDER_ID: '1xoY8aJpl3v9dvAipXGcc-DM_l-wonWo1',
  DEST_FOLDER_ID: '1IeX1yg7vxUqyGSuowJAzrs1sTbPcf366',
  MODELO_GEMINI: 'gemini-3.8-flash',
  GAP_ENTRE_PRENDAS_SEGUNDOS: 120,
  TIEMPO_SEGURIDAD_SUBIDA: 30,
  MINUTOS_DURACION_ERROR: 5
};

function getConfigSecreta() {
  const props = PropertiesService.getScriptProperties();
  return {
    GEMINI_API_KEY: props.getProperty('GEMINI_API_KEY'),
    TELEGRAM_BOT_TOKEN: props.getProperty('TELEGRAM_BOT_TOKEN'),
    TELEGRAM_CHAT_ID: props.getProperty('TELEGRAM_CHAT_ID')
  };
}

function procesarBandejaVinted() {
  const tiempoInicio = new Date().getTime();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;

  try {
    const props = PropertiesService.getScriptProperties();
    const inbox = DriveApp.getFolderById(CONFIG.INBOX_FOLDER_ID);
    const destFolder = DriveApp.getFolderById(CONFIG.DEST_FOLDER_ID);

    rescatarCarpetasAtascadas(inbox, destFolder, props);
    limpiarMensajesErrorTelegram(false);

    const filesIterator = inbox.getFiles();
    let files = [];
    while (filesIterator.hasNext()) {
      let file = filesIterator.next();
      if (file.isTrashed()) continue;
      
      let mime = (file.getMimeType() || '').toLowerCase();
      let name = file.getName().toLowerCase();
      
      if (mime.startsWith('image/') || name.endsWith('.heic') || name.endsWith('.heif')) {
        files.push(file);
      }
    }
    
    if (files.length === 0) return;

    files.sort((a, b) => a.getDateCreated().getTime() - b.getDateCreated().getTime());

    const ahora = new Date().getTime();
    const ultimaSubida = files[files.length - 1].getDateCreated().getTime();
    if (Math.round((ahora - ultimaSubida) / 1000) < CONFIG.TIEMPO_SEGURIDAD_SUBIDA) return;

    let grupos = [];
    let grupoActual = [files[0]];

    for (let i = 1; i < files.length; i++) {
      let diffSegundos = (files[i].getDateCreated().getTime() - files[i - 1].getDateCreated().getTime()) / 1000;
      if (diffSegundos <= CONFIG.GAP_ENTRE_PRENDAS_SEGUNDOS) {
        grupoActual.push(files[i]);
      } else {
        grupos.push(grupoActual);
        grupoActual = [files[i]];
      }
    }
    grupos.push(grupoActual);

    for (let i = 0; i < grupos.length; i++) {
      if ((new Date().getTime() - tiempoInicio) > 180000) break;

      const grupo = grupos[i];
      try {
        let esDuplicado = false;
        for (let j = 0; j < grupo.length; j++) {
          const checksum = obtenerHashArchivo(grupo[j]);
          if (checksum && props.getProperty('HASH_EJE_' + checksum)) {
            esDuplicado = true;
            break;
          }
        }

        if (esDuplicado) {
          moverADuplicados(grupo, destFolder, inbox, props);
          continue;
        }

        Logger.log(`Analizando prenda de ${grupo.length} fotos...`);
        const datosProducto = analizarConGeminiRapido(grupo);
        
        const tituloLimpio = (datosProducto.titulo || 'Prenda Vinted').replace(/[\/\\?%*:|"<>]/g, '-');
        const nombreFinal = `${tituloLimpio} (${datosProducto.precio_salida || 'Sin precio'})`;
        const nuevaCarpeta = destFolder.createFolder(nombreFinal);
        
        grupo.forEach(file => {
          const checksum = obtenerHashArchivo(file);
          file.moveTo(nuevaCarpeta);
          if (checksum) props.setProperty('HASH_EJE_' + checksum, 'REGISTRADO');
        });

        limpiarMensajesErrorTelegram(true);
        enviarFichaTelegram(datosProducto, nuevaCarpeta.getUrl(), grupo.length);
        
      } catch (errGrupo) {
        Logger.log('❌ Fallo temporal: ' + errGrupo.toString());
        enviarAlertaErrorTemporalTelegram(
          `⏳ <b>Servidor ocupado (${grupo.length} fotos)</b>\n` +
          `Reintentando en el próximo turno.\n<code>${errGrupo.message}</code>`
        );
        break;
      }
    }
  } catch (errGeneral) {
    Logger.log('Error general: ' + errGeneral.toString());
  } finally {
    lock.releaseLock();
  }
}

function moverADuplicados(grupo, destFolder, inbox, props) {
  let dupFolder;
  const folders = destFolder.getFoldersByName('⚠️ DUPLICADOS_REPETIDOS');
  if (folders.hasNext()) {
    dupFolder = folders.next();
  } else {
    dupFolder = destFolder.createFolder('⚠️ DUPLICADOS_REPETIDOS');
  }

  const subCarpetaDup = dupFolder.createFolder(`Duplicado (${new Date().toLocaleString()})`);
  grupo.forEach(file => {
    try { file.moveTo(subCarpetaDup); } catch (e) { file.moveTo(inbox); }
  });

  const creds = getConfigSecreta();
  const url = `https://api.telegram.org/bot${creds.TELEGRAM_BOT_TOKEN}/sendMessage`;
  UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      chat_id: creds.TELEGRAM_CHAT_ID,
      text: `⚠️ <b>AVISO: Producto Duplicado Detectado</b>\nEstas fotos ya se procesaron anteriormente y se han movido a <i>⚠️ DUPLICADOS_REPETIDOS</i>.`,
      parse_mode: 'HTML'
    }),
    muteHttpExceptions: true
  });
}

function rescatarCarpetasAtascadas(inbox, destFolder, props) {
  const folders = destFolder.getFolders();
  while (folders.hasNext()) {
    let folder = folders.next();
    if (folder.getName().indexOf('⏳ Analizando') !== -1) {
      let files = folder.getFiles();
      while (files.hasNext()) {
        let f = files.next();
        f.moveTo(inbox);
        props.deleteProperty('PROCESADO_' + f.getId());
      }
      folder.setTrashed(true);
    }
  }
}

function convertirArchivoAJpg(file) {
  const token = ScriptApp.getOAuthToken();
  const metaUrl = `https://www.googleapis.com/drive/v3/files/${file.getId()}?fields=thumbnailLink`;
  const metaRes = UrlFetchApp.fetch(metaUrl, {
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });
  
  if (metaRes.getResponseCode() === 200) {
    const meta = JSON.parse(metaRes.getContentText());
    if (meta.thumbnailLink) {
      const jpgUrl = meta.thumbnailLink.replace(/=s\d+/, '=s1200'); // Calidad de fotos intacta
      const imgRes = UrlFetchApp.fetch(jpgUrl, {
        headers: { Authorization: 'Bearer ' + token },
        muteHttpExceptions: true
      });
      
      if (imgRes.getResponseCode() === 200) {
        return {
          mimeType: 'image/jpeg',
          base64: Utilities.base64Encode(imgRes.getBlob().getBytes())
        };
      }
    }
  }
  throw new Error(`Vista previa no disponible para ${file.getName()}`);
}

function analizarConGeminiRapido(archivos) {
  const creds = getConfigSecreta();
  const prompt = `Actúa como un experto tasador y vendedor Top en Vinted España. Analiza TODAS estas fotos de UN MISMO artículo y devuelve ÚNICAMENTE un JSON válido con esta estructura:
{
  "titulo": "Título perfecto para Vinted (máx 50 caracteres: Prenda + Marca + Estilo + Color + Talla)",
  "descripcion": "Descripción persuasiva en 2-3 párrafos cortos con saltos de línea. Incluye estilo, detalles, composición, estado y cierre de envío rápido.",
  "marca": "Marca exacta leída en etiqueta/logo (o 'Sin marca visible')",
  "talla": "Talla exacta leída en etiqueta (o 'Ver medidas')",
  "composicion": "Materiales leídos en etiqueta (ej: '100% Algodón' o 'No visible')",
  "estado": "Nuevo con etiquetas / Nuevo sin etiquetas / Muy bueno / Bueno",
  "categoria": "Ruta exacta en Vinted",
  "color": "Color principal y secundario",
  "precio_salida": "Precio recomendado para publicar (ej: 25€)",
  "precio_minimo": "Precio mínimo para aceptar ofertas (ej: 18€)",
  "hashtags": "#hashtag1 #hashtag2 #hashtag3 #hashtag4 #hashtag5 #hashtag6"
}`;

  let parts = [{ text: prompt }];

  for (let i = 0; i < archivos.length; i++) {
    const imgData = convertirArchivoAJpg(archivos[i]);
    parts.push({
      inline_data: {
        mime_type: imgData.mimeType,
        data: imgData.base64
      }
    });
  }

  const payload = {
    contents: [{ parts: parts }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.2
    }
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.MODELO_GEMINI}:generateContent?key=${creds.GEMINI_API_KEY}`;

  for (let intento = 1; intento <= 2; intento++) {
    const response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    const code = response.getResponseCode();
    if (code === 200) {
      const json = JSON.parse(response.getContentText());
      return JSON.parse(json.candidates[0].content.parts[0].text);
    }
    if (intento === 1 && (code === 503 || code === 429)) {
      Utilities.sleep(5000);
    }
  }

  throw new Error('Servidor Gemini ocupado (503). Se reintentará en el próximo turno.');
}

function enviarFichaTelegram(datos, carpetaUrl, numFotos) {
  const creds = getConfigSecreta();
  const url = `https://api.telegram.org/bot${creds.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const mensaje = `🛍️ <b>NUEVA PRENDA LISTA (${numFotos} fotos)</b>\n` +
                  `📁 <a href="${carpetaUrl}">Abrir carpeta ordenada en Drive</a>\n\n` +
                  `📌 <b>TÍTULO (toca para copiar):</b>\n<code>${datos.titulo}</code>\n\n` +
                  `📝 <b>DESCRIPCIÓN (toca para copiar):</b>\n<code>${datos.descripcion}\n\n${datos.hashtags}</code>\n\n` +
                  `🏷️ <b>DATOS PARA VINTED:</b>\n` +
                  `• <b>Marca:</b> ${datos.marca}\n` +
                  `• <b>Talla:</b> ${datos.talla}\n` +
                  `• <b>Material:</b> ${datos.composicion}\n` +
                  `• <b>Estado:</b> ${datos.estado}\n` +
                  `• <b>Color:</b> ${datos.color}\n` +
                  `• <b>Categoría:</b> ${datos.categoria}\n\n` +
                  `💰 <b>ESTRATEGIA DE PRECIO:</b>\n` +
                  `• <b>Publicar a:</b> ${datos.precio_salida}\n` +
                  `• <b>Aceptar ofertas hasta:</b> ${datos.precio_minimo}`;
  
  UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      chat_id: creds.TELEGRAM_CHAT_ID,
      text: mensaje,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    }),
    muteHttpExceptions: true
  });
}

function enviarAlertaErrorTemporalTelegram(textoError) {
  const creds = getConfigSecreta();
  const sendUrl = `https://api.telegram.org/bot${creds.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = UrlFetchApp.fetch(sendUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      chat_id: creds.TELEGRAM_CHAT_ID,
      text: textoError,
      parse_mode: 'HTML',
      disable_notification: true
    }),
    muteHttpExceptions: true
  });

  try {
    const data = JSON.parse(res.getContentText());
    if (data.ok && data.result && data.result.message_id) {
      const props = PropertiesService.getScriptProperties();
      let listaErrores = JSON.parse(props.getProperty('MENSAJES_ERROR_TELEGRAM') || '[]');
      listaErrores.push({ id: data.result.message_id, time: new Date().getTime() });
      props.setProperty('MENSAJES_ERROR_TELEGRAM', JSON.stringify(listaErrores));
    }
  } catch (e) {}
}

function borrarMensajeTelegram(messageId) {
  const creds = getConfigSecreta();
  const delUrl = `https://api.telegram.org/bot${creds.TELEGRAM_BOT_TOKEN}/deleteMessage`;
  UrlFetchApp.fetch(delUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      chat_id: creds.TELEGRAM_CHAT_ID,
      message_id: messageId
    }),
    muteHttpExceptions: true
  });
}

function limpiarMensajesErrorTelegram(forzarBorradoTotal) {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty('MENSAJES_ERROR_TELEGRAM');
  if (!raw) return;

  try {
    const lista = JSON.parse(raw);
    const ahora = new Date().getTime();
    const limiteMs = CONFIG.MINUTOS_DURACION_ERROR * 60 * 1000;
    let pendientes = [];

    lista.forEach(item => {
      const msgIdReal = typeof item === 'object' && item.id ? item.id : item;
      const msgTime = typeof item === 'object' && item.time ? item.time : 0;

      if (forzarBorradoTotal || (ahora - msgTime) >= limiteMs) {
        borrarMensajeTelegram(msgIdReal);
      } else {
        pendientes.push(item);
      }
    });

    if (pendientes.length > 0) {
      props.setProperty('MENSAJES_ERROR_TELEGRAM', JSON.stringify(pendientes));
    } else {
      props.deleteProperty('MENSAJES_ERROR_TELEGRAM');
    }
  } catch (e) {
    props.deleteProperty('MENSAJES_ERROR_TELEGRAM');
  }
}

function obtenerHashArchivo(file) {
  try {
    const bytes = file.getBlob().getBytes();
    const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, bytes);
    return Utilities.base64Encode(digest);
  } catch (e) {
    return file.getName() + '_' + file.getSize();
  }
}
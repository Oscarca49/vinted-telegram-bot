# 🛍️ Vinted Telegram Bot (Google Apps Script + Gemini AI)

Sistema automatizado en la nube para procesar fotos de ropa desde el móvil, analizarlas con Inteligencia Artificial y recibir las fichas de venta listas para copiar y publicar en Vinted.

## 🚀 ¿Cómo funciona el flujo?
1. **Entrada:** Subes las fotos de una prenda a una carpeta específica de Google Drive[cite: 1].
2. **Proceso automático:** Un disparador (trigger) ejecuta el script cada 5 minutos. El sistema agrupa las imágenes, calcula una huella digital para evitar duplicados y envía las fotos a la API de **Google Gemini Flash**[cite: 1].
3. **Salida:** Se crea una carpeta organizada en Drive con el nombre de la prenda y su precio estimado, y el bot de **Telegram** te envía una ficha con el título, la descripción persuasiva y los datos clave estructurados en bloques de copia rápida (`<code>`)[cite: 1].

## 🛠️ Stack Tecnológico
* **Google Apps Script (JavaScript):** Motor backend sin servidores, ejecutado de forma gratuita en la nube de Google[cite: 1].
* **Google AI Studio (Gemini Flash):** Análisis visual de etiquetas, tallas, composición y generación de copywriting optimizado para ventas.
* **Telegram Bot API:** Notificaciones en tiempo real y alertas de errores autogestionadas.

## 🔒 Seguridad y Privacidad
Este repositorio utiliza **Google Apps Script Properties** para desacoplar y proteger las credenciales sensibles (como el Token de Telegram y la API Key de Gemini), garantizando que el código fuente sea seguro para entornos públicos.

---
*Desarrollado como proyecto de automatización personal.*

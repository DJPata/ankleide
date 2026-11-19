# Ankleide – Prototyp

Web-App: Kleidung fotografieren, Porträt hochladen, Anlass wählen. Gemini stellt ein Outfit aus deinem Schrank zusammen und zeigt dich darin.

## Einrichten (einmalig, ca. 5 Minuten)

1. **Node.js installieren** (Version 18 oder neuer): https://nodejs.org → „LTS“ herunterladen und installieren.
2. **Gemini-API-Schlüssel holen:** https://aistudio.google.com/apikey → mit Google-Konto anmelden → „API-Schlüssel erstellen“.
3. Im Ordner `ankleide` die Datei `.env.example` kopieren, die Kopie `.env` nennen und den Schlüssel hinter `GEMINI_API_KEY=` einfügen.

## Starten

- **Mac:** Doppelklick auf `start-mac.command` (beim ersten Mal ggf. Rechtsklick → Öffnen).
- **Windows:** Doppelklick auf `start-windows.bat`.
- Oder im Terminal: `node server.js` und dann http://localhost:3000 öffnen.

Vom Handy im selben WLAN: `http://<IP-deines-Computers>:3000`.

## So funktioniert's

| Schritt | Was passiert | KI |
|---|---|---|
| Schrank | Jedes Foto wird verkleinert und analysiert: Kategorie, Farbe, Material, Formalität 1–5 | Gemini Text (`gemini-3.5-flash`) |
| Anziehen | Anlass + Wetter + Wünsche + Schrankliste → Outfit mit Begründung | Gemini Text |
| Anprobieren | Porträt + Fotos der gewählten Teile → Bild von dir im Outfit | Gemini Image / Nano Banana (`gemini-nano-banana-2.1`) |

- Fotos und Schrank bleiben **lokal im Browser** (IndexedDB). An Google gehen nur die Bilder, die für eine Anfrage nötig sind.
- Der API-Schlüssel bleibt auf dem Server (`server.js`) und erscheint nie im Browser.
- Modelle lassen sich in `.env` tauschen, z. B. `GEMINI_IMAGE_MODEL=gemini-3-pro-image` für höhere Qualität.

## Kosten

Analyse und Vorschläge kosten Bruchteile eines Cents. Ein Anprobe-Bild kostet je nach Modell grob 2–15 Cent. Aktuelle Preise: https://ai.google.dev/pricing

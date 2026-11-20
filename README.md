# Haushaltshilfe

Vier Helfer in einer Handy-Web-App (Google Gemini):

- **Ankleidezimmer** (`ankleidezimmer.html`): Kleiderschrank fotografieren, Anlass wählen, Outfit + Anprobe-Bild
- **Küchenhilfe** (`kueche.html`): Kühlschrank fotografieren → Zutaten → Rezept nach Zeit und Richtung
- **Einkaufsliste** (`einkauf.html`): abhaken, mit KI zusammenfassen und nach Abteilung sortieren
- **Flora-Park** (`pflanzen.html`): Pflanzen fotografieren → Gießrhythmus, Heute-gießen-Liste, Erinnerungen über den iPhone-Kalender
- **Mikrofon auf der Startseite** (`voice.js`): frei sprechen → Gemini verteilt auf Einkauf, Putzen, Pflanzen, To-do; Vorschau-Karten
- **Kalender** (kalender.html): gemeinsamer Kalender pro Haushalt, Termine gemeinsam oder pro Person, dazu Gießen, Putzplan und To-dos mit Datum.
- **To-dos** (`sprache.html`): To-do- und Putz-Liste, Kalender-Export
- **Home Cleaner** (`putzen.html`): Stelle fotografieren → Putz-Anleitung, Mittel, Sicherheitshinweise

**App öffnen:** https://djpata.github.io/ankleide/

- In Safari öffnen → Einstellungen → Gemini-Schlüssel eintragen (bleibt nur auf dem Gerät) → Teilen → „Zum Home-Bildschirm“.
- Fotos und Schrank werden nur im Browser des Geräts gespeichert.
- `computer-version/` enthält die Variante mit kleinem Node-Server, bei der der Schlüssel auf dem Computer bleibt.

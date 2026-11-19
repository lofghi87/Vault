# Configurazione Google Drive per Vault

## Come funziona

- L'utente sceglie la destinazione prima di ogni caricamento: Backblaze B2 oppure uno degli account Google Drive collegati.
- La cifratura AES-256-GCM avviene nel browser, prima che il file lasci il dispositivo. Google Drive riceve soltanto il file cifrato con estensione `.vlt`.
- Per ogni account Google, Vault crea la cartella **Vault - video cifrati** nel suo Drive.
- Un utente può collegare più account Google, riconoscerli tramite indirizzo email, sceglierne uno per ogni caricamento e scollegarli separatamente.
- Scollegare un account revoca il token conservato da Vault, ma non elimina i file da quel Google Drive.
- L'ambito OAuth usato è `drive.file`: consente a Vault di creare e gestire i file che l'app ha creato, senza chiedere accesso indiscriminato a tutto il Drive.

## Configurazione una tantum Google Cloud

1. Crea o seleziona un progetto in Google Cloud Console.
2. Abilita **Google Drive API** per quel progetto.
3. Configura la schermata di consenso OAuth:
   - Nome applicazione: Vault.
   - Tipo di pubblico: External, se Vault deve poter essere usato da account Google personali.
   - Aggiungi gli ambiti `openid`, `email`, `profile` e `https://www.googleapis.com/auth/drive.file`.
   - Durante i test, aggiungi gli indirizzi Google dei tester tra i test user.
4. Crea un OAuth Client ID di tipo **Web application**.
5. Aggiungi questo URI esatto tra gli URI di reindirizzamento autorizzati:

```
https://vault-private.vercel.app/api/google-drive/callback
```

6. Copia il Client ID e il Client Secret. Non inserirli nel codice sorgente e non inviarli in chat.

## Variabili Vercel necessarie

Nel progetto Vercel **vault**, ambiente **Production**, aggiungi le seguenti variabili come segreti:

| Nome | Valore |
|---|---|
| `GOOGLE_CLIENT_ID` | Client ID OAuth creato in Google Cloud |
| `GOOGLE_CLIENT_SECRET` | Client Secret OAuth creato in Google Cloud |
| `SUPABASE_SERVICE_ROLE_KEY` | Chiave server `service_role` del progetto Supabase Vault; mai la chiave anon/publishable |
| `GOOGLE_TOKEN_ENCRYPTION_KEY` | Già generata e configurata da Vault in Vercel |

`VITE_SUPABASE_URL` è già presente nel progetto. Il callback usa per impostazione predefinita il dominio di produzione indicato sopra; non è necessario aggiungere `GOOGLE_REDIRECT_URI` a meno che non si cambi dominio.

Dopo aver aggiunto i primi tre valori, avvia un nuovo deploy Production. Per utilizzare anche Preview o Development, configura separatamente le stesse variabili per quegli ambienti e usa i rispettivi URI di callback.

## Nota sullo stato OAuth di Google

Un progetto OAuth esterno lasciato in modalità **Testing** può ricevere refresh token che scadono dopo 7 giorni quando richiede permessi Drive. Per un utilizzo continuativo e da parte di utenti non aggiunti come tester, occorre completare la pubblicazione e la verifica OAuth richieste da Google. L'ambito `drive.file` è quello più ristretto e consigliato per questo tipo di integrazione.

## Sicurezza e limiti

- I refresh token Google sono cifrati lato server con AES-256-GCM prima di essere memorizzati nel database.
- Il browser non riceve Client Secret, refresh token o access token Google persistenti.
- I file Google Drive sono di proprietà dell'utente Google e occupano il suo spazio Drive.
- La quota Vault di 2 GB riguarda esclusivamente lo spazio personale Backblaze B2; non si applica ai file salvati nel Drive personale.
- I link temporanei attuali vengono preparati tramite una copia cifrata su Backblaze B2 e quindi consumano la quota Backblaze dell'utente.
- I file Google Drive scollegati da Vault restano nel Drive originale. Per rivederli, bisogna ricollegare lo stesso account Google.

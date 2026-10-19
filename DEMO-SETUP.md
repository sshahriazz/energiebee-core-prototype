# Run the EnergieBee demo with real provider data

This guide runs the focused demo branch and fetches real readings directly from Sunsynk and Octopus. You do not need a separately supplied database or demo-data package.

## 1. What you need

- Git.
- Node.js **22.13 or newer**, including npm. Node 22.22.0 was used for the setup check.
- Access to the GitHub repository.
- An internet connection.
- Sunsynk Connect email and password, plus the plant ID if the login has multiple plants.
- Octopus API key and account number for the **same property**. Find these in the account's developer/API settings.

Both providers are needed to demonstrate the full inverter-plus-smart-meter workflow. Without Octopus readings, grid readings may use the inverter fallback and remain provisional. The application stores its own SQLite database; no separate database installation is needed.

Check your tools in Terminal or PowerShell:

```bash
git --version
node --version
npm --version
```

## 2. Download the demo branch

```bash
git clone https://github.com/sshahriazz/energiebee-core-prototype.git
cd energiebee-core-prototype
git switch demo/core-energy
npm ci
```

If you already have the repository, save your current work first, then run:

```bash
cd energiebee-core-prototype
git fetch origin
git switch demo/core-energy
git pull --ff-only origin demo/core-energy
npm ci
```

## 3. Set up the provider connections

Copy `.env.example` to a file named `.env` in the project folder. Do not overwrite an existing configuration.

On macOS or Linux:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Open `.env` in a text editor. Replace the matching settings with your values:

```dotenv
PORT=4102
DB_FILE=data/core.db

SITE_NAME="My home"
SITE_POSTCODE="YOUR_POSTCODE"

SUNSYNK_USERNAME="YOUR_EMAIL"
SUNSYNK_PASSWORD="YOUR_PASSWORD"
SUNSYNK_PLANT_ID="YOUR_PLANT_ID"

OCTOPUS_API_KEY="YOUR_API_KEY"
OCTOPUS_ACCOUNT_NUMBER="YOUR_ACCOUNT_NUMBER"

SYNC_EVERY_MINUTES=10
INITIAL_DAYS=14
```

Replace the example values; do not leave `YOUR_...` placeholders in the file. If the Sunsynk login has just one plant, its ID can be left empty. Quoting values prevents spaces or `#` in a password from being interpreted as formatting; use single quotes around a value containing double quotes.

Fill in the solar-panel and battery specifications from the installation documents if known. Leave unknown values blank. The unrelated optional credentials in `.env.example` are not required for this electricity demo.

Keep `.env` private. It is excluded from Git. The local database and raw provider responses are also excluded from Git and can contain account and property information.

## 4. Start the application

From the project folder:

```bash
npm start
```

Open **http://localhost:4102** in a browser. Leave the terminal running.

On the first run, the application:

1. Creates the local database.
2. Connects to the configured providers.
3. Requests the previous 14 days plus the current day, subject to provider availability.
4. Saves original responses and readings.
5. Builds the half-hour calculations used by the demo screens.

The first sync is not instant. The page can show no recorded days while it runs. Wait for `synced …: ok` or `synced …: partial` in the terminal, then refresh the browser. A partial sync needs inspection; it does not automatically mean the electricity data failed.

The server syncs again every 10 minutes while running. Refresh the browser to see newly built readings. Smart-meter readings can arrive later than inverter readings; provisional intervals are expected until the required data arrives.

Use **`npm start`** for this setup. **`npm run demo`** is a separate frozen-snapshot mode that disables provider sync and does not load `.env`.

## 5. Check the demo

- **Overview:** choose a recorded day and inspect its energy totals.
- **Timeline:** expand a half-hour to see sources, coverage, calculations and checks.
- **Evidence:** open original provider responses and inspect reading versions.
- **How it works:** read the notebook-and-calculator explanation.

The live-sync setup still uses the focused demo screens. Some explanatory copy currently describes the frozen presentation mode; `npm start` does fetch provider updates in the background.

For technical sync status, open **http://localhost:4102/api/status**. `/api/sites` includes connection status and the completed sync's step details. Keep these responses private when troubleshooting because they can include property details.

## 6. Stop and restart

Press **Ctrl+C** in the terminal to stop.

To restart later:

```bash
cd energiebee-core-prototype
npm start
```

The saved database is reused. Do not run `npm run reset` unless you intend to delete the local database and raw provider responses.

Optional automated checks:

```bash
npm test
```

## Troubleshooting

| What you see | What to check |
| --- | --- |
| GitHub says repository not found or access denied | Sign in with a GitHub account that has repository access. |
| `node` or `npm` is not found | Install Node.js, reopen the terminal, and check the version. |
| SQLite is unavailable | Use Node.js 22.13 or newer. |
| `.env` cannot be found | Create it in the project folder; make sure it is not named `.env.txt`. |
| Port already in use | Change `PORT` in `.env`, restart, and use that port in the browser URL. |
| No home appears | Check that at least one complete provider credential pair is filled in, then restart. |
| No recorded days appear | Allow the initial sync to finish, refresh, and inspect sync status if it remains empty. |
| Provider authentication fails | Check credentials, account access and plant ID, then restart. |
| Recent intervals remain provisional | Check provider status and allow time for smart-meter readings to arrive. |
| Sync reports `partial` | Inspect which provider step failed; other provider data may still have loaded successfully. |

## Fresh-install verification

Tested on **19 October 2026** with macOS, Node.js 22.22.0 and npm 10.9.4, using published branch commit `7707595`.

- Cloned the branch from GitHub into an isolated folder and ran `npm ci` successfully.
- Started with **no database and no copied raw data**. Configured the existing real provider accounts in a private `.env` file.
- Ran `npm start` on port **4113** to avoid other local servers. The guide uses 4102; the only difference is the port.
- The first sync completed with status **ok** in **61 seconds**. Sunsynk and Octopus both succeeded, along with all other configured sync steps.
- Created **28,781 readings**, **3,436 interval facts**, **53 raw payload records** and **690 half-hour records across 15 dates**.
- The default date, **17 October 2026**, had **48 final half-hours**.
- Chrome checks passed for Overview, Timeline, Evidence and How it works, including expanding an interval and opening an original provider response. No browser JavaScript errors occurred.
- The full automated suite returned **52 passed and 2 failed**. The failures were the history reconstruction test (`r.versions > 0`) and the solar-expected daily performance ratio test for the current day. The setup and browser workflow passed, but the full suite is not clean on this freshly synced dataset.

**Result:** fetching real data and running the focused demo works with the tested accounts. No separate demo files are needed. Initial-sync time and available readings will vary by account and provider response. Windows/Linux setup was not executed in this check.

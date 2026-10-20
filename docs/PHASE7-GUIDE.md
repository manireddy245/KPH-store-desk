# Phase 7: owner screen, Telugu screens, encrypted second backup, daily summary

## Owner page (top menu → Owner)
Made for the owner's phone. When someone with the reports permission opens Store Desk on a phone, it starts here.

- **Today at a glance:** sales, money collected, new credit given (with what is overdue), cash in hand, cash / UPI / card split, expenses, purchases entered, discount given.
- **Alerts:** cancelled bills, discounts above the limit, admin PIN approvals, credit bills over the limit, cancelled receipts, stock corrections, and any counter cash difference. Tap one to open the Activity log.
- **Top items** and **top partners** for the day.
- **Stock & deliveries:** items out of stock or low, items that will run out in 3 days, deliveries not done yet, and money stuck in slow and dead stock.
- Use the date box at the top to see any earlier day.

## Daily summary
- Made by itself at closing time: Settings → Shop & billing → **Shop closes at** (8:30 pm). If the PC was switched off before then, it is made the next morning when the PC starts.
- On the Owner page, pick **తెలుగు** or **English**, then press:
  - **WhatsApp:** opens WhatsApp with the summary, addressed to the owner's number (Settings → **Owner's WhatsApp number**)
  - **E-mail:** opens your mail app
  - **Copy:** copies it so you can paste it anywhere
- **Show past summaries** lists the earlier days.
- Nothing is sent by itself. You always press the button.

## Telugu screens
- Every person chooses their own language with the **తెలుగు / English** button in the top bar. The choice is saved with that person, so it follows them to any counter.
- The menu, page titles and the billing screen change to Telugu. Words that have no Telugu version yet stay in English, so nothing ever shows blank.
- Bills, reports and exports stay in English, as GST needs.

## Shorter menu
- On computers, the main items stay in the top bar and the rest are under **More**.
- On phones, everything is in **Menu**.

## Encrypted second copy of backups
Backups used to stay only on the server PC. Now every backup is also copied to a second place, so a broken, stolen or burnt PC doesn't take the books with it.

1. Settings → **Data & backups** → **Second copy (encrypted)**.
2. Choose a folder. Any of these works:
   - **USB drive:** for example `E:\StoreDesk backups`. Leave the drive plugged in.
   - **Another PC in the shop:** a shared folder, for example `\\OFFICE-PC\Backups`.
   - **Google Drive or OneDrive:** install the Drive app on the server PC and choose a folder inside it. The copies then go to the cloud by themselves, at no cost. This is the best choice because it is outside the shop.
3. Type a **passphrase** of at least 8 characters, twice. **Write it on paper and keep it at home.** Without it the copies can't be opened, by anyone, including us.
4. Press **Save**, then **Back up now**. The status should say **Last copy OK**.

What happens after that:
- Every daily backup and every **Back up now** is copied. The copy is opened and checked straight away, and the last 30 are kept.
- The Dashboard warns the admin if no second place is set up, or if a copy fails (for example, the USB drive was taken out).
- The Gemini key and the passphrase are never put inside a backup.

### Restoring from an encrypted copy
Settings → Data & backups → **Restore from a backup** → choose the `.enc` file → type the passphrase. You can leave the passphrase blank on the same PC, because it is saved there. Then press **Restore…**. A safety backup of the current data is made first, as before.

## New settings
- **Shop & billing → Owner & daily summary:** owner's WhatsApp number, owner's e-mail, shop closing hour, and how many days a quotation stays valid.
- **Shop & billing → Stock advice:**
  - how many days of sales to look back over (default 30)
  - dead stock after how many days (default 60)
  - order enough for how many days (default 15)
  - how many days the supplier takes to deliver (default 3)
  - when cement or a batch counts as old (default 60 days)

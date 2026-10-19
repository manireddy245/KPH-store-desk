# Assistant: chat, photos and voice notes

**Assistant** in the top menu is a chat. You can:

- **Type** a question or an instruction, in English, Telugu or a mix.
- **Attach photos or PDFs.** The camera button opens the phone camera; the clip button picks files.
- **Record a voice note** with the microphone button (up to 2 minutes). The chat shows what it heard under your note.

It uses the same Google Gemini key as the invoice scanner (Settings → Shop & billing).

## What it can do

| You say or send | What happens |
|---|---|
| "Today's sales?", "Sales this month", "How much does Ravi owe?", "Which items are low?" | Answers from the books. It looks up the real figures and never guesses. Sales reports need the *reports* permission. |
| A **photo or PDF of a supplier bill** | The scanner reads the bill. A **Supplier bill** card shows the supplier, bill number, items (matched or new) and total. **Review & save purchase** opens the usual review screen. |
| "20 bags PPC and 10 rods 12mm for Reddy on credit" | A **Bill draft** card. **Open in Billing** puts the items, customer and payment mode on the billing screen. You check them and save as usual. |
| "5 bags cement got wet" (typed or spoken) | A **Stock correction** card showing 317 → 312 bag and the reason. **Change stock** saves it, recorded as an adjustment that says it came from the assistant. |
| "New customer Lakshmi Traders, 98480…, GSTIN …" | A **New customer** card. It warns you if the GSTIN check digit is wrong. |
| "Reddy paid 10,000 by UPI" | A **Payment received** card showing the balance before and after. **Save receipt** creates the receipt. |
| A photo of a customer's handwritten list | Usually a **Bill draft** card. |

## Safety

- **The assistant never saves anything by itself.** Bills, stock, purchases, customers and payments are saved only when a person presses the button on a card.
- Saving goes through the same checks as the normal screens:
  - permissions
  - discount limits and the admin PIN
  - stock checks
  - the duplicate-bill check
  - the GST rules
- Staff only get cards for things they are allowed to do. For example, counter staff get no stock-correction card; the assistant tells them to ask admin.
- Each person sees only their own chat. **Clear chat** hides the messages but deletes nothing.
- Photos and voice notes are kept on the shop server, next to the scanned bills. Chats are included in backups. The Gemini key is not.

## Voice notes on phones

Browsers only allow the microphone on secure (https) addresses, or on the server PC itself.

- **On the server PC**, or once the cloud copy has an https address, the mic button records directly.
- **On a phone using the shop Wi-Fi address** (`http://192.168.…`), the mic button opens the phone's own voice recorder instead. Record, tap done, then press send. Both ways work the same.

## Try it (sample workspace)

1. As admin, add the Gemini key in Settings → Shop & billing.
2. Assistant → tap **Which items are running low?**
3. Type *20 bags PPC cement for Srinivasa Reddy on credit* → **Open in Billing**. The lines and customer are filled in; save or remove them.
4. Record a voice note in Telugu, e.g. *ఐదు సిమెంట్ బస్తాలు తడిసి పాడయ్యాయి* → check the "Heard" text → **Change stock**.
5. Photograph a supplier bill → **Review & save purchase**.

## Notes for later

- The assistant uses the Gemini model set in Settings (the same one as the scanner).
- Each message costs one to four Gemini calls. A bill photo costs one more, for the scanner. On the free tier, the daily limit can run out on a busy day. You will see "Google Gemini is busy or the free limit is used up".
- Coming later: reports and GST exports from Phase 2B, available through the chat too.

## When Google is busy

Sometimes Google's servers are overloaded ("high demand", error 503). This is on Google's side; your key and the shop server are fine.

- Store Desk tries again by itself twice, a few seconds apart.
- If it still fails, the chat shows the reason and a **Try again** button. The button resends the same message, with its photos or voice note, so you don't have to type or record it again.

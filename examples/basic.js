const { ZaSend } = require("../src");

async function main() {
  const zasend = new ZaSend(process.env.ZASEND_API_KEY);
  const result = await zasend.sendEmail({
    from: "zaSend <noreply@zasend.com>",
    to: "user@example.com",
    subject: "Hello from zaSend",
    text: "This message was sent with the zaSend Node.js client.",
  });
  console.log(result);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

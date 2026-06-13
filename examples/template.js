const { ZaSend } = require("../src");

async function main() {
  const zasend = new ZaSend(process.env.ZASEND_API_KEY);
  const result = await zasend.sendTemplateEmail({
    from: "zaSend <noreply@zasend.com>",
    to: "user@example.com",
    template: "welcome",
    variables: { name: "Ada" },
  });
  console.log(result);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

/** 空账号时的初始化页：创建第一个管理员后跳到控制台。 */
const form = document.getElementById("setup");
const error = document.getElementById("error");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.textContent = "";
  try {
    const res = await fetch("/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: document.getElementById("username").value.trim(),
        password: document.getElementById("password").value,
      }),
      redirect: "manual",
    });
    if (res.status === 303) {
      location.href = "/";
      return;
    }
    const body = await res.json().catch(() => ({}));
    error.textContent = body.error || "创建失败";
  } catch {
    error.textContent = "请求没有送到";
  }
});

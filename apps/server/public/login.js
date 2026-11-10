const form = document.getElementById('login');
const err = document.getElementById('err');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.hidden = true;
  const btn = form.querySelector('button');
  btn.disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ username: form.username.value, password: form.password.value }),
    });
    if (res.ok) {
      location.replace('/');
      return;
    }
    const data = await res.json().catch(() => ({}));
    err.textContent = data.error || '登录失败';
    err.hidden = false;
  } catch {
    err.textContent = '网络错误';
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

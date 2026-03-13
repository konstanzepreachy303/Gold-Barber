self.addEventListener("push", (event) => {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {
      title: "Gold Barber",
      body: "Nova atualização de agendamento."
    };
  }

  const title = data.title || "Gold Barber";

  const options = {
    body: data.body || "Nova atualização.",
    icon: "/img/icon-192.png",
    badge: "/img/icon-192.png",
    tag: data.tag || "goldbarber-notification",
    renotify: true,
    requireInteraction: true, // mantém a notificação visível
    data: {
      url: data.url || "/admin"
    }
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const url = event.notification?.data?.url || "/admin";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(url) && "focus" in client) {
          return client.focus();
        }
      }

      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    })
  );
});
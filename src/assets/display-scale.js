(function () {
  var ua = navigator.userAgent || '';
  var tablet = /iPad|Tablet|PlayBook|Silk/i.test(ua);
  var phone = !tablet && (/iPhone|iPod|Windows Phone|IEMobile|\bPhone\b|\bMobi(?:le)?\b|webOS|BlackBerry|BB10/i.test(ua)
    || (navigator.userAgentData && navigator.userAgentData.mobile === true));
  var scale = phone ? '1' : '0.9';
  document.documentElement.style.setProperty('--ui-scale', scale);
  document.documentElement.style.setProperty('zoom', scale);
  document.documentElement.dataset.deviceKind = phone ? 'phone' : 'other';
}());

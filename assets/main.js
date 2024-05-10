importJavaScript('copy-email-to-clipboard');

$(document).ready(function() {
    setupCopyEmailToClipboard();
});

function importJavaScript(scriptName) {
    document.write('<script type="text/javascript" src="/assets/js/' + scriptName + '.js"></script>');
}

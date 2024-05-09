function getTOCNodes(master) {
    return Array.from(master.querySelectorAll(".toc a"));
}

function getHeaderNodes(master) {
    return Array.from(master.querySelectorAll(".post-article h1, .post-article h2, .post-article h3, .post-article h4, .post-article h5, .post-article h6"));
}

var title = document.querySelector(".post-title");
var titleY = title.offsetTop;

var article = document.querySelector(".post-article");
var toc = document.querySelector(".toc");

var headerNodes = getHeaderNodes(article);
var tocNodes = getTOCNodes(toc);

var before;

document.addEventListener('scroll', function(e) {
    var articleY = article.offsetTop;

    if (window.scrollY >= articleY - 60) {
        toc.style.cssText = "position: fixed; top: 60px;";
    } else {
        toc.style.cssText = "";
    }

    var current = headerNodes.filter(function(header) {
        var headerY = header.offsetTop;
        return window.scrollY >= headerY - 60;
    });

    if (current.length > 0) {
        current = current[current.length - 1];

        var currentA = tocNodes.find(function(tocNode) {
            return tocNode.innerHTML == current.innerText;
        });

        if (currentA && before !== currentA) {
            if (before) {
                before.classList.remove("toc-active");
            }

            currentA.classList.add("toc-active");
            before = currentA;
        }
    } else {
        if (before) {
            before.classList.remove("toc-active");
            before = undefined;
        }
    }

}, false);

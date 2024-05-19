---
layout: post
title:  "[Troubleshooting - DB] 외래키(Foreign Key)와 데드락(DeadLock) 그리고 쿼리 지연 실행"
comments: true
tags: Troubleshooting
excerpt_separator: <!--more-->
lang: ko
permalink: /dead-lock-by-fk/
---

![](https://velog.velcdn.com/images/haron/post/b3f75582-672b-43ae-9972-b5fc8e5a1cc9/image.png)
데드락이 발생할 때마다, 페페가 울고 있다😢 간헐적으로 발생하던 데드락의 원인을 분석하고, 해결 과정을 기록해보자.  

## 외래키(Foreign Key)와 데드락(DeadLock)
**데드락**이란, 둘 이상의 프로세스가 다른 프로세스가 점유하고 있는 자원을 서로 기다릴 때 무한 대기에 빠지는 상황이다.  
![](https://velog.velcdn.com/images/haron/post/33d1e1aa-b838-40e9-bbbd-af4480a0d5fe/image.png)  
P1은 P2가 가지고 있는 자원이 해제 되길 기다리고, P2는 P3이 가진 자원, 그 다음..과 같은 형식으로 가장 마지막의 프로세스 Pn가 다시 P1이 가진 자원을 요청하고 해제 되길 기다리는 형태이다.

**외래키**란, 외래키는 두 테이블을 서로 연결하는 데 사용되는 키이다. 외래키가 포함된 테이블을 자식 테이블이라고 하고 외래키 값을 제공하는 테이블을 부모 테이블이라고 한다.

> Real MySQL 3장을 보면, 아래와 같은 글이 있다.
"외래키는 부모테이블이나 자식 테이블에 데이터가 있는지 체크하는 작업이 필요하므로 잠금이 여러 테이블로 전파되고, 그로인해 데드락이 발생할 수 있다. 그래서 실무에서는 잘 사용하지 않는다."

![](https://velog.velcdn.com/images/haron/post/9cb67c04-19fc-4701-98c1-b6a45971eaa9/image.png)  
오호라... 잠금이 여러테이블로 전파된다고?!!

## 데드락이 발생하는 상황 재현
### 준비물은 이렇게 준비해주세요

```sql
CREATE TABLE parent
(
    id             bigint        not null primary key,
    name           varchar(255)  null,
    updated_at     datetime(6)   null
);

CREATE TABLE child
(
    id           bigint          not null primary key,
    name         varchar(255)    null,
    parent_id    bigint          null,
    CONSTRAINT parent_id_unique UNIQUE (parent_id),
    CONSTRAINT child_fk FOREIGN KEY (parent_id) REFERENCES parent (id)
);


CREATE TABLE child_index
(
    id           bigint          not null primary key,
    name         varchar(255)    null,
    parent_id    bigint          null,
    CONSTRAINT child_index_fk FOREIGN KEY (parent_id) REFERENCES parent (id)
);
CREATE INDEX parent_id ON child_index (parent_id);

INSERT INTO parent VALUES (1, 'parent_1', NOW());
```
1. parent 테이블의 id를 foreign key / unique key로 가지고 있는 child 테이블 생성
2. parent 테이블의 id를 foreign key / idnex로 가지고 있는 child_index 테이블 생성
3. parent 테이블에 테스트 데이터 적재

### 그럼 이제 데드락을 발생시켜 보자
### 자식 row insert -> 부모 row update 가 2개의 세션에서 수행되면, 데드락이 발생 💣
![](https://velog.velcdn.com/images/haron/post/64f10100-a470-43a9-af95-c4a372b5bd22/image.png)  

|TX1|TX2|lock|
|------|---|---|
|BEGIN ;  <br> INSERT INTO child VALUES (1, 'child1', 1);||(1) child X,REC_NOT_GAP Lock, parent S Lock|
||BEGIN ;  <br> INSERT INTO child VALUES (1, 'child1', 1);|(2) child X Lock 대기, parent S Lock|
|UPDATE parent SET name = 'newParent' WHERE id = 1;||(3)|
||Deadlock found when trying to get lock; try restarting transaction|(3) parent X lock 이 필요하지만, (2) 에서 parent는 S lock 상태 <br> (3) 해소를 위해서 (2) 해소 필요 <br> -> (2) 해소 위해서 TX1 커밋 필요 <br> -> TX1이 커밋하려면 (3) 해소 필요 <br> -> 데드락 발생|

![](https://velog.velcdn.com/images/haron/post/609d3b4c-6e3d-4743-af14-5449b7b730fe/image.jpeg)  

> 자식 테이블에 대한 쓰기 쿼리를 수행할 때 foreign 키 제약으로 인해 부모의 잠금 상태를 확인후 문제가 없으면 쿼리를 수행하고, 정합성을 유지하기 위해 부모 테이블에 해당 행을 공유잠금 한다.

> 공유 락(Shared(S) Lock)
공유 락(Shared Lock)은 읽기 락(Read Lock)이라고도 불린다. 공유 락이 걸린 데이터에 대해서는 읽기 연산(SELECT)만 실행 가능하며, 쓰기 연산은 실행이 불가능하다. 공유 락이 걸린 데이터에 대해서 다른 트랜잭션도 똑같이 공유 락을 획득할 수 있으나, 배타 락은 획득할 수 없다. 공유 락이 걸려도 읽기 작업은 가능하다는 뜻이다.
공유 락을 사용하면, 조회한 데이터가 트랜잭션 내내 변경되지 않음을 보장한다.

> 베타 락(Exclusive(X) Lock)
배타 락은 쓰기 락(Write Lock)이라고도 불린다. 데이터에 대해 배타 락을 획득한 트랜잭션은, 읽기 연산과 쓰기 연산을 모두 실행할 수 있다. 다른 트랜잭션은 배타 락이 걸린 데이터에 대해 읽기 작업도, 쓰기 작업도 수행할 수 없다. 즉, 배타 락이 걸려있다면 다른 트랜잭션은 공유 락, 배타 락 둘 다 획득 할 수 없다. 배타 락을 획득한 트랜잭션은 해당 데이터에 대한 독점권을 갖는 것이다.

### 부모 row update → 자식 row insert 가 두개의 세션에서 수행되면, 중복키 에러 발생
![](https://velog.velcdn.com/images/haron/post/f36e285b-25f9-42f7-a233-7864a0ad9244/image.png)  
부모 row 에서 먼저 update 가 일어나면, 데드락은 발생하지 않는다. 중복키 에러는 서비스 특성상 필요해서 추가한 옵션이다.

## 운영환경에서 데드락이 발생하는 로직을 살펴보자
- 서비스에서는 jpa 를 사용하고 있어, `show-sql` 옵션을 통해 확인하자.
```sql
SELECT * from parent WHERE id = 1;
INSERT INTO child VALUES (1, 'child_1', 1);
DELETE FROM child_index WHERE parent_id = 1;
INSERT INTO child_index VALUES (1, 'child_index_1', 1);
UPDATE parent SET  updated_at = NOW() WHERE id = 1;
```
(테이블 및 컬럼을 간소화 시킨 버전)

### 자식 row insert -> 부모 row update 가 2개의 세션에서 수행되면, 데드락이 발생 💣
![](https://velog.velcdn.com/images/haron/post/b5700769-98a0-45f6-9858-2594d362f922/image.png)  

- 2개의 세션에서 실행되는 이유를 프론트에서 보내는 따닥(2번 이상의 동시 요청)으로 보았다. 🖱🤏🖱🤏
- 프론트의 다른 버튼에서는 같은 이슈가 없는데, 해당 버튼만 데드락이 발생하는 것도 궁금하다 🤔

## 원인은 알았고, 서버에서 데드락을 해결할 수 있는 방법을 고민해보자

### ❎ 첫번째 시도, 부모 row update → 자식 row insert 로직으로 변경해서 중복키 에러 발생하도록 조정
```java
  @Transactional
  public void createChildAndChildIndex (long parentId) {

    var parent = parentRepository.findById(parentId);
    // 부모 row update 
    paraent.setUpdateAt(LocalDateTime.now());
    
    // 자식 row insert
    childRepository.save(new Child('child_1', parent));
    
    childIndexRepository.deleteByParent(parent);
    childIndexRepository.save(new Child_Index('child_index_1', parent));

  }
```
하지만 여전히 자식 row insert → 부모 row update 로직으로 쿼리가 나가서 데드락이 발생하고 있다. 😇

### Hibernate 쿼리 실행 우선순위
JPA 쓰기 지연 덕분에 service method 가 끝나고 트랜잭션이 커밋되는 시점에 쿼리가 DB에 반영된다는 것은 알고 있었지만, 우선순위가 있었다고..??

```
OrphanRemovalAction
AbstractEntityInsertAction
EntityUpdateAction
QueuedOperationCollectionAction
CollectionRemoveAction
CollectionUpdateAction
CollectionRecreateAction
EntityDeleteAction

1. Inserts, in the order they were performed
2. Updates
3. Deletion of collection elements
4. Insertion of collection elements
5. Deletes, in the order they were performed
```
fyi; [하이버네이트 쿼리 실행 순서](https://docs.jboss.org/hibernate/orm/6.1/javadocs/org/hibernate/event/internal/AbstractFlushingEventListener.html#performExecutions(org.hibernate.event.spi.EventSource))  

> 외래키 제약 조건이란?
외래키를 갖는 테이블에 데이터를 삽입할 때는 기준 테이블(외래키에 해당되는 테이블)에 실제로 존재하는 데이터만 참조해야 한다. 없는 데이터를 참조해서 외래키로 써먹으면 안된다고. 그래서 항상 insert가 먼저 되게 하는 것 같다!

로직을 변경했음에도 여전히 자식 row insert → 부모 row update 로직으로 쿼리가 나가는 이유는 쓰기 지연에 의해 자식 row insert 가 부모 row update 보다 우선 수행되기 때문이군!

### ❎ 두번째 시도, 부모 row update 후에 flush() 하여 쿼리 실행
```java
  @Transactional
  public void createParent (long parentId) {

    var parent = parentRepository.findById(parentId);
    // 부모 row update 
    paraent.setUpdateAt(LocalDateTime.now());
    // 부모 row update 후에 flush()
    parentRepository.flush();
    
    // 자식 row insert
    childRepository.save(new Child('child_1', parent));
    
    childIndexRepository.deleteByParent(parent);
    childIndexRepository.save(new Child_Index('child_index_1', parent));

  }
```

로직대로 쿼리가 나간다!
```sql
SELECT * from parent WHERE id = 1;
UPDATE parent SET  updated_at = NOW() WHERE id = 1;
INSERT INTO child VALUES (1, 'child_1', 1);
DELETE FROM child_index WHERE parent_id = 1;
INSERT INTO child_index VALUES (1, 'child_index_1', 1);
```
- 하지만 flush() 가 어떤 사이드 이펙이 있을지와 나중에 히스토리를 모르는 동료가 뜬금없는 flush() 를 보고 이해하지 못 하는 문제가 있다.

### ✅ 세번째 시도, 자식 테이블에 존재하는 외래키 제거
🤔 2288112 개의 row 가 있는 테이블에서 외래키 제거하는데 소요되는 시간은?!

- 자식 row 에 변경사항 때문에 부모 row까지 공유잠금이 걸려서 데드락이 발생하고 있다. 근본적인 문제를 제거하면 되지 않을까?
- 외래키를 제거하는 동안 서비스 중단이 생길까 걱정이 되기도 하고, 궁금해서 해본 테스트
  54973 기준 14 ms 소요

![](https://velog.velcdn.com/images/haron/post/b66d04a1-8e93-4f24-a8bb-f135946f7669/image.png)  
- 팀에서 논의 후에 서비스 중단 없이 fk 키를 제거하였고, 모니터링 결과 외래키 제거 후에 자식 테이블에서 발생하던 `SQLTransactionRollbackException`(데드락) 은 `DataIntegrityViolationException`(중복키) 로 발생된다.

![](https://velog.velcdn.com/images/haron/post/fa8c8a3e-ad61-4977-b1ff-585b0d262293/image.png)  

### 못 해치웠ㄴ...
[인덱스가 날 기다리고 있었..](https://velog.io/@haron/%ED%8A%B8%EB%9F%AC%EB%B8%94%EC%8A%88%ED%8C%85-DB-%EC%9D%B8%EB%8D%B1%EC%8A%A4Index%EC%99%80-%EB%8D%B0%EB%93%9C%EB%9D%BDDeadLock-in8ryzsm)  

## 정리
1. 외래키가 걸려있는 경우, 자식 row에 변경이 일어나면 부모 row에 공유 잠금이 걸린다.
2. JPA 쿼리 지연에는 실행 순서가 있다.
3. FK 키를 제거하는데 소요되는 시간은 생각보다 적다.

### 기록용
<details>
<summary>SHOW ENGINE innodb STATUS;</summary>
- SHOW ENGINE innodb STATUS;
  LOCK WAIT 4 lock struct(s), heap size 1128, 2 row lock(s), undo log entries 1
  *** (1) HOLDS THE LOCK(S):

  RECORD LOCKS space id 148 page no 4 n bits 72 index PRIMARY of table `jpa`.`parent` trx id 12534 lock mode S locks rec but not gap

  Record lock, heap no 2 PHYSICAL RECORD: n_fields 4; compact format; info bits 0

  *** (1) WAITING FOR THIS LOCK TO BE GRANTED:
  RECORD LOCKS space id 149 page no 5 n bits 72 index parent_id_unique of table `jpa`.`child` trx id 12534 lock mode S waiting
  Record lock, heap no 2 PHYSICAL RECORD: n_fields 2; compact format; info bits 0

  *** (2) TRANSACTION:

  TRANSACTION 12533, ACTIVE 13 sec starting index read

  mysql tables in use 1, locked 1

  LOCK WAIT 6 lock struct(s), heap size 1128, 3 row lock(s), undo log entries 1

  MySQL thread id 128, OS thread handle 6143324160, query id 12894 localhost 127.0.0.1 root updating

  /* ApplicationName=DataGrip 2022.3.2 */ UPDATE parent SET name = 'newParent' WHERE id = 1

  *** (2) HOLDS THE LOCK(S):
  RECORD LOCKS space id 149 page no 5 n bits 72 index parent_id_unique of table `jpa`.`child` trx id 12533 lock_mode X locks rec but not gap
  Record lock, heap no 2 PHYSICAL RECORD: n_fields 2; compact format; info bits 0

  *** (2) WAITING FOR THIS LOCK TO BE GRANTED:
  RECORD LOCKS space id 148 page no 4 n bits 72 index PRIMARY of table `jpa`.`parent` trx id 12533 lock_mode X locks rec but not gap waiting

  Record lock, heap no 2 PHYSICAL RECORD: n_fields 4; compact format; info bits 0
</details>
